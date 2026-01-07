#include <chrono>
#include <iostream>
#include <set>
#include <queue>
#include <mutex>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#include <stdint.h>
#include <string>
#include <cinttypes>
#include <stdio.h>
#include <stdlib.h>
#include <cstring> // Needed for memset
#include <vector>
#include <type_traits>

extern "C" {
#include "video.h"
#include "video_shm.h"
#include "mongoose.h"
}

#define TAG "camera-streamer"
#define WS_PORT "8765"
#define MAX_QUEUE_SIZE 30  // Drop frames if queue gets too large
#define NUM_CHANNELS 3     // CH0, CH1, CH2
#define POLL_TIMEOUT_MS 10 // Mongoose poll timeout
#define MAX_FRAMES_PER_BATCH 3 // Process up to 10 frames per channel per iteration

// Per-channel state structure
typedef struct {
    video_ch_index_t channel_id;
    video_ch_param_t params;
    std::queue<std::pair<uint8_t*, size_t>> frame_queue;
    std::mutex queue_mutex;
    std::set<struct mg_connection*> ws_clients;
    std::mutex clients_mutex;
    video_shm_producer_t shm_producer;
    bool shm_enabled;
    std::vector<uint8_t> sps_cache;  // Cache SPS for keyframes
    std::vector<uint8_t> pps_cache;  // Cache PPS for keyframes
    std::mutex header_mutex;
} channel_state_t;

static volatile bool g_running = true;
static struct mg_mgr g_mgr;
static channel_state_t g_channels[NUM_CHANNELS];

// Signal handler for graceful shutdown
static void signal_handler(int signo) {
    if (signo == SIGINT || signo == SIGTERM) {
        printf("%s: Received signal %d, shutting down...\n", TAG, signo);
        g_running = false;
    }
}

// Helper function to parse WebSocket channel parameter
static int parse_channel_param(struct mg_http_message *hm) {
    char channel_str[8] = {0};
    int channel = -1;
    
    // Extract channel parameter from query string
    int len = mg_http_get_var(&hm->query, "channel", channel_str, sizeof(channel_str));
    if (len > 0) {
        channel = atoi(channel_str);
        if (channel >= 0 && channel < NUM_CHANNELS) {
            return channel;
        }
    }
    return -1;  // Invalid or missing channel parameter
}

// Helper to set channel ID in connection data
static void set_connection_channel(struct mg_connection *c, int channel) {
    // Store channel in first byte of connection data
    c->data[0] = (char)channel;
}

// Helper to get channel ID from connection data
static int get_connection_channel(struct mg_connection *c) {
    return (int)(unsigned char)c->data[0];
}

// WebSocket event handler
static void ws_handler(struct mg_connection *c, int ev, void *ev_data) {
    if (ev == MG_EV_HTTP_MSG) {
        struct mg_http_message *hm = (struct mg_http_message *) ev_data;
        if (mg_match(hm->uri, mg_str("/"), NULL)) {
            // Parse required channel parameter
            int channel = parse_channel_param(hm);
            if (channel < 0) {
                // Reject connection - channel parameter required
                mg_http_reply(c, 400, "Content-Type: text/plain\r\n",
                            "Error: channel parameter required (0-2)\n"
                            "Example: ws://device-ip:8765/?channel=1\n");
                return;
            }
            
            // Store channel ID in connection data
            set_connection_channel(c, channel);
            mg_ws_upgrade(c, hm, NULL);
        } else {
            mg_http_reply(c, 404, "", "Not Found\n");
        }
    } else if (ev == MG_EV_WS_OPEN) {
        int channel = get_connection_channel(c);
        std::lock_guard<std::mutex> lock(g_channels[channel].clients_mutex);
        g_channels[channel].ws_clients.insert(c);
        printf("%s: WebSocket client connected to CH%d (%zu total)\n", 
               TAG, channel, g_channels[channel].ws_clients.size());
    } else if (ev == MG_EV_CLOSE || ev == MG_EV_ERROR) {
        // Remove from the channel this connection was subscribed to
        int channel = get_connection_channel(c);
        if (channel >= 0 && channel < NUM_CHANNELS) {
            std::lock_guard<std::mutex> lock(g_channels[channel].clients_mutex);
            auto it = g_channels[channel].ws_clients.find(c);
            if (it != g_channels[channel].ws_clients.end()) {
                g_channels[channel].ws_clients.erase(it);
                printf("%s: WebSocket client disconnected from CH%d (%zu remaining)\n", 
                       TAG, channel, g_channels[channel].ws_clients.size());
            }
        }
    }
}

// Video frame callback - queues frames for main thread to send
static int video_frame_callback(void* pData, void* pArgs, void* pUserData) {
    VENC_STREAM_S* pstStream = (VENC_STREAM_S*)pData;
    channel_state_t* channel = (channel_state_t*)pUserData;
    
    if (!g_running || pstStream->u32PackCount == 0 || !channel) {
        return CVI_SUCCESS;
    }

    // Get current timestamp
    auto now = std::chrono::system_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
    uint64_t timestamp = static_cast<uint64_t>(ms);

    // Prepare frame data
    for (CVI_U32 i = 0; i < pstStream->u32PackCount; i++) {
        VENC_PACK_S* ppack = &pstStream->pstPack[i];
        uint8_t* frame_data = ppack->pu8Addr + ppack->u32Offset;
        uint32_t frame_len = ppack->u32Len - ppack->u32Offset;

        // Detect SPS/PPS and cache them
        bool is_sps = (ppack->DataType.enH264EType == H264E_NALU_SPS);
        bool is_pps = (ppack->DataType.enH264EType == H264E_NALU_PPS);
        bool is_keyframe = (ppack->DataType.enH264EType == H264E_NALU_IDRSLICE ||
                           ppack->DataType.enH264EType == H264E_NALU_ISLICE);

        if (is_sps) {
            std::lock_guard<std::mutex> lock(channel->header_mutex);
            channel->sps_cache.assign(frame_data, frame_data + frame_len);
            // Don't send SPS separately, we'll prepend to keyframes
            continue;
        }
        
        if (is_pps) {
            std::lock_guard<std::mutex> lock(channel->header_mutex);
            channel->pps_cache.assign(frame_data, frame_data + frame_len);
            // Don't send PPS separately, we'll prepend to keyframes
            continue;
        }

        // For keyframes, prepend SPS+PPS - allocate persistent buffer
        uint8_t* final_frame_data = frame_data;
        uint32_t final_frame_len = frame_len;
        uint8_t* combined_buffer = nullptr;
        
        if (is_keyframe) {
            std::lock_guard<std::mutex> lock(channel->header_mutex);
            if (!channel->sps_cache.empty() && !channel->pps_cache.empty()) {
                // Allocate persistent buffer for combined frame: SPS + PPS + Keyframe
                final_frame_len = channel->sps_cache.size() + channel->pps_cache.size() + frame_len;
                combined_buffer = new uint8_t[final_frame_len];
                
                // Copy SPS + PPS + Keyframe into persistent buffer
                size_t offset = 0;
                memcpy(combined_buffer + offset, channel->sps_cache.data(), channel->sps_cache.size());
                offset += channel->sps_cache.size();
                memcpy(combined_buffer + offset, channel->pps_cache.data(), channel->pps_cache.size());
                offset += channel->pps_cache.size();
                memcpy(combined_buffer + offset, frame_data, frame_len);
                
                final_frame_data = combined_buffer;
            }
        }

        // Write to shared memory (zero-copy for local apps)
        if (channel->shm_enabled) {
            video_frame_meta_t meta = {0};
            meta.timestamp_ms = timestamp;
            meta.size = final_frame_len;
            meta.is_keyframe = is_keyframe ? 1 : 0;
            meta.codec = 0;  // H.264
            meta.width = channel->params.width;
            meta.height = channel->params.height;
            meta.fps = channel->params.fps;

            if (video_shm_producer_write(&channel->shm_producer, final_frame_data, final_frame_len, &meta) < 0) {
                printf("%s: WARNING: Failed to write frame to shared memory CH%d\n", 
                       TAG, channel->channel_id);
            }
        }

        // Allocate buffer for frame: [channel_id(1)] + [frame_data(N)] + [timestamp(8)]
        size_t total_len = 1 + final_frame_len + 8;
        uint8_t* buffer = new uint8_t[total_len];
        
        // Pack: channel ID + frame data + timestamp
        buffer[0] = (uint8_t)channel->channel_id;
        memcpy(buffer + 1, final_frame_data, final_frame_len);
        memcpy(buffer + 1 + final_frame_len, &timestamp, 8);
        
        // Free combined buffer if it was allocated
        if (combined_buffer) {
            delete[] combined_buffer;
        }

        // Queue frame for main thread to send
        {
            std::lock_guard<std::mutex> lock(channel->queue_mutex);
            if (channel->frame_queue.size() < MAX_QUEUE_SIZE) {
                channel->frame_queue.push(std::make_pair(buffer, total_len));
            } else {
                // Queue full, drop frame and free buffer
                delete[] buffer;
            }
        }
    }

    return CVI_SUCCESS;
}

// Initialize a single channel
static int init_channel(channel_state_t* channel, video_ch_index_t ch_id, 
                        const video_ch_param_t* params) {
    channel->channel_id = ch_id;
    channel->params = *params;
    channel->shm_enabled = false;
    
    // Initialize shared memory IPC with channel-specific name
    printf("%s: Initializing shared memory for CH%d at /video_stream_ch%d\n", TAG, ch_id, ch_id);
    
    if (video_shm_producer_init_channel(&channel->shm_producer, ch_id) != 0) {
        fprintf(stderr, "%s: WARNING: Failed to initialize shared memory for CH%d\n", TAG, ch_id);
    } else {
        channel->shm_enabled = true;
        printf("%s: Shared memory IPC enabled for CH%d\n", TAG, ch_id);
    }
    
    // Configure video channel
    printf("%s: Configuring CH%d: %dx%d @ %dfps H.264\n", 
           TAG, ch_id, params->width, params->height, params->fps);
    
    if (setupVideo(ch_id, params) != 0) {
        fprintf(stderr, "%s: Failed to setup CH%d\n", TAG, ch_id);
        if (channel->shm_enabled) {
            video_shm_producer_destroy(&channel->shm_producer);
        }
        return -1;
    }
    
    // Register frame callback with channel context
    registerVideoFrameHandler(ch_id, 0, video_frame_callback, channel);
    
    return 0;
}

// Cleanup a single channel
static void cleanup_channel(channel_state_t* channel) {
    printf("%s: Cleaning up CH%d...\n", TAG, channel->channel_id);
    
    // Clear frame queue
    {
        std::lock_guard<std::mutex> lock(channel->queue_mutex);
        while (!channel->frame_queue.empty()) {
            delete[] channel->frame_queue.front().first;
            channel->frame_queue.pop();
        }
    }
    
    // Cleanup shared memory
    if (channel->shm_enabled) {
        video_shm_producer_destroy(&channel->shm_producer);
    }
}

// Process queued frames and send to clients (called from main thread)
static void process_frame_queues() {
    for (int ch = 0; ch < NUM_CHANNELS; ch++) {
        channel_state_t* channel = &g_channels[ch];
        
        // Process multiple frames per iteration for better throughput
        int frames_processed = 0;
        while (frames_processed < MAX_FRAMES_PER_BATCH) {
            std::pair<uint8_t*, size_t> frame;
            bool has_frame = false;
            
            // Get frame from queue
            {
                std::lock_guard<std::mutex> lock(channel->queue_mutex);
                if (!channel->frame_queue.empty()) {
                    frame = channel->frame_queue.front();
                    channel->frame_queue.pop();
                    has_frame = true;
                }
            }
            
            if (!has_frame) {
                break; // No more frames for this channel
            }
            
            // Make a copy of client connections to avoid holding mutex during I/O
            std::vector<struct mg_connection*> clients_copy;
            {
                std::lock_guard<std::mutex> lock(channel->clients_mutex);
                clients_copy.reserve(channel->ws_clients.size());
                for (auto conn : channel->ws_clients) {
                    clients_copy.push_back(conn);
                }
            }
            
            // Send to all clients without holding the mutex
            for (auto conn : clients_copy) {
                if (conn && conn->is_websocket) {
                    mg_ws_send(conn, frame.first, frame.second, WEBSOCKET_OP_BINARY);
                }
            }
            
            // Free buffer
            delete[] frame.first;
            frames_processed++;
        }
    }
}

int main(int argc, char* argv[]) {
    printf("%s: Starting multi-channel camera streamer on port %s\n", TAG, WS_PORT);

    // Setup signal handlers
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    // Initialize video subsystem
    printf("%s: Initializing video subsystem...\n", TAG);
    if (initVideo() != 0) {
        fprintf(stderr, "%s: Failed to initialize video\n", TAG);
        return -1;
    }

    // Configure all three channels
    video_ch_param_t params[NUM_CHANNELS] = {
        // CH0: High resolution - 1920x1080 @ 30fps
        { .format = VIDEO_FORMAT_H264, .width = 1920, .height = 1080, .fps = 30 },
        // CH1: Medium resolution - 1280x720 @ 30fps
        { .format = VIDEO_FORMAT_H264, .width = 1280, .height = 720, .fps = 30 },
        // CH2: Low resolution - 640x480 @ 15fps
        { .format = VIDEO_FORMAT_H264, .width = 640, .height = 480, .fps = 15 }
    };
    
    // Initialize all channels
    bool all_channels_ok = true;
    for (int ch = 0; ch < NUM_CHANNELS; ch++) {
        if (init_channel(&g_channels[ch], (video_ch_index_t)ch, &params[ch]) != 0) {
            fprintf(stderr, "%s: Failed to initialize CH%d, continuing with other channels\n", TAG, ch);
            all_channels_ok = false;
        }
    }
    
    if (!all_channels_ok) {
        fprintf(stderr, "%s: WARNING: Not all channels initialized successfully\n", TAG);
    }

    // Initialize Mongoose WebSocket server
    mg_mgr_init(&g_mgr);
    char url[64];
    snprintf(url, sizeof(url), "http://0.0.0.0:%s", WS_PORT);
    
    printf("%s: Starting WebSocket server on %s\n", TAG, url);
    struct mg_connection *listen_conn = mg_http_listen(&g_mgr, url, ws_handler, NULL);
    
    if (listen_conn == NULL) {
        fprintf(stderr, "%s: Failed to start WebSocket server\n", TAG);
        // Cleanup channels before deinit
        for (int ch = 0; ch < NUM_CHANNELS; ch++) {
            cleanup_channel(&g_channels[ch]);
        }
        deinitVideo();
        return -1;
    }

    // Start video streaming
    printf("%s: Starting video streams...\n", TAG);
    if (startVideo() != 0) {
        fprintf(stderr, "%s: Failed to start video streams\n", TAG);
        mg_mgr_free(&g_mgr);
        // Cleanup channels before deinit
        for (int ch = 0; ch < NUM_CHANNELS; ch++) {
            cleanup_channel(&g_channels[ch]);
        }
        deinitVideo();
        return -1;
    }

    printf("%s: Multi-channel camera streamer is running\n", TAG);
    printf("%s: CH0: 1920x1080@30fps (High) - ws://<device-ip>:%s/?channel=0\n", TAG, WS_PORT);
    printf("%s: CH1: 1280x720@30fps (Medium) - ws://<device-ip>:%s/?channel=1\n", TAG, WS_PORT);
    printf("%s: CH2: 640x480@15fps (Low) - ws://<device-ip>:%s/?channel=2\n", TAG, WS_PORT);
    printf("%s: Press Ctrl+C to stop\n", TAG);

    // Main event loop - process both mongoose events AND frame queues
    while (g_running) {
        mg_mgr_poll(&g_mgr, POLL_TIMEOUT_MS);
        process_frame_queues();   // Send queued frames
    }

    // Cleanup
    printf("%s: Cleaning up...\n", TAG);
    
    // Cleanup all channels
    for (int ch = 0; ch < NUM_CHANNELS; ch++) {
        cleanup_channel(&g_channels[ch]);
    }
    
    deinitVideo();
    mg_mgr_free(&g_mgr);
    
    printf("%s: Shutdown complete\n", TAG);
    return 0;
}
