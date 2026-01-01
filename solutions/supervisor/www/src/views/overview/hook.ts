import { useState, useEffect, useRef } from "react";
import useWebSocket, { ReadyState } from "react-use-websocket";
import { getWebSocketUrlApi } from "@/api";
import jmuxer from "jmuxer";

let jmuxerIns: any;

interface ChannelInfo {
  id: number;
  name: string;
  resolution: string;
  fps: number;
  bitrate: string;
  codec: string;
  use_case: string;
  websocket_url: string;
  shm_path: string;
  active: boolean;
}

interface ChannelsResponse {
  channels: ChannelInfo[];
  default_channel: number;
}

export default function usehookData() {
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<number>(1); // Default to CH1
  const [channelsLoaded, setChannelsLoaded] = useState<boolean>(false);
  const [socketUrl, setSocketUrl] = useState<string | null>(null);
  const [timeObj, setTimeObj] = useState({
    time: 0,
    delay: 0,
  });
  
  const { getWebSocket, readyState } = useWebSocket(socketUrl, {
    onMessage,
    shouldReconnect: () => true,
  });

  // Fetch channel list from API
  useEffect(() => {
    fetch('/api/channels')
      .then(res => res.json())
      .then((response: any) => {
        // Handle standard API response format: {code, msg, data}
        if (response.code === 0 && response.data) {
          const data: ChannelsResponse = response.data;
          setChannels(data.channels || []);
          setSelectedChannel(data.default_channel || 1);
          setChannelsLoaded(true);
        } else {
          console.error('API error:', response.msg);
          setSelectedChannel(1);
          setChannelsLoaded(true);
        }
      })
      .catch(err => {
        console.error('Failed to fetch channels:', err);
        // Fallback to default if API fails
        setSelectedChannel(1);
        setChannelsLoaded(true);
      });
  }, []);

  // Get WebSocket URL with channel parameter
  const getWebsocketUrl = async () => {
    try {
      const { data } = await getWebSocketUrlApi({
        time: Date.now(),
      });
      
      // Supervisor's camera WebSocket URL is already configured
      // Append channel parameter to the URL
      let wsUrl = data.websocketUrl;
      
      // Check if URL already has query parameters
      const separator = wsUrl.includes('?') ? '&' : '?';
      wsUrl = wsUrl + separator + 'channel=' + selectedChannel;
      
      setSocketUrl(wsUrl);
      
      // Set binary type after connection
      setTimeout(() => {
        const obj: any = getWebSocket();
        if (obj) {
          obj.binaryType = "arraybuffer";
        }
      }, 0);
    } catch (err) {
      console.log("err:", err);
    }
  };

  // Reconnect when selected channel changes (only after channels are loaded)
  useEffect(() => {
    if (channelsLoaded && selectedChannel !== null) {
      // Destroy existing jmuxer
      if (jmuxerIns) {
        jmuxerIns.destroy();
      }
      
      // Find channel info for selected channel
      const channelInfo = channels.find(ch => ch.id === selectedChannel);
      const fps = channelInfo ? channelInfo.fps : 30;
      
      // Create new jmuxer with correct FPS
      jmuxerIns = new jmuxer({
        debug: false,
        node: "player",
        mode: "video",
        flushingTime: 0,
        fps: fps,
        clearBuffer: true,
      });
      
      // Reconnect WebSocket with new channel
      getWebsocketUrl();
    }
  }, [selectedChannel, channelsLoaded]);

  function onMessage(evt: MessageEvent) {
    var buffer = new Uint8Array(evt.data);
    
    // Extract channel ID (first byte)
    const channelId = buffer[0];
    
    // Extract timestamp (last 8 bytes)
    const lastEight = buffer.slice(-8);
    const dataView = new DataView(lastEight.buffer);
    const high = dataView.getUint32(4, true);
    const low = dataView.getUint32(0, true);
    const int64Value = (BigInt(high) << BigInt(32)) | BigInt(low);
    const time = Number(int64Value);
    
    setTimeObj({
      time: time,
      delay: Date.now() - time,
    });
    
    // Feed frame to jmuxer (skip channel ID byte, exclude timestamp bytes)
    if (jmuxerIns) {
      const frameData = buffer.subarray(1, buffer.length - 8);
      jmuxerIns.feed({
        video: frameData,
      });
    }
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (jmuxerIns) {
        jmuxerIns.destroy();
      }
    };
  }, []);

  // Function to switch channels
  const switchChannel = (channelId: number) => {
    setSelectedChannel(channelId);
  };

  return { 
    timeObj, 
    channels, 
    selectedChannel, 
    switchChannel,
    connectionState: readyState 
  };
}
