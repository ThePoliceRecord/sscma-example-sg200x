# Camera Streamer

## Overview

**camera-streamer** is a WebSocket video streaming server that captures H.264 video from the camera and streams it to web clients. This replaces the previous Node-RED based streaming functionality.

## Features

- Real-time H.264 video streaming via WebSocket
- **Zero-copy shared memory IPC for local applications**
- Automatic timestamp appending for latency measurement
- Compatible with the existing Supervisor web UI
- Lightweight and efficient using Mongoose WebSocket server
- Based on proven Sophgo video SDK
- Multiple concurrent consumers supported

## Architecture

```
Camera (sg200x) → Video SDK → H.264 Encoder → ┬→ Shared Memory (/video_stream) → Local Apps
                                               │   (zero-copy, <1ms latency)
                                               │
                                               └→ WebSocket (port 8765) → Web Browser
                                                   (+ 8-byte timestamp)
```

## Building

### Prerequisites

Ensure you have set up the **ReCamera-OS** environment:
```bash
export SG200X_SDK_PATH=<PATH_TO_RECAMERA-OS>/output/sg2002_recamera_emmc/
export PATH=<PATH_TO_RECAMERA-OS>/host-tools/gcc/riscv64-linux-musl-x86_64/bin:$PATH
```

### Build Steps

**Important:** Build from the solution directory, not the repository root.

```bash
cd solutions/camera-streamer
cmake -B build -DCMAKE_BUILD_TYPE=Release .
cmake --build build
```

The CMakeLists.txt will automatically find components relative to the repository root.

### Create Package

```bash
cd build && cpack
```

This creates `camera-streamer-1.0.0-1.deb`

## Installation

### Transfer to Device

```bash
scp build/camera-streamer-1.0.0-1.deb recamera@192.168.42.1:/tmp/
```

### Install on Device

```bash
ssh recamera@192.168.42.1
sudo opkg install /tmp/camera-streamer-1.0.0-1.deb
```

## Usage

### Manual Start

```bash
camera-streamer
```

The server will start on port **8765** and begin streaming H.264 video.

### Auto-start with Supervisor

The camera-streamer can be automatically started by the supervisor service. The supervisor will manage its lifecycle.

## Shared Memory IPC

The camera-streamer now provides **zero-copy shared memory IPC** for local applications to access video frames with minimal latency.

### Quick Start

```bash
# Build example consumer
cd examples
make

# Run consumer (in separate terminal)
./video_consumer
```

### Documentation

- **[Shared Memory IPC Guide](SHARED_MEMORY_IPC.md)** - Complete API reference and integration guide
- **[Testing Guide](TESTING_GUIDE.md)** - Step-by-step testing procedures
- **[Example Consumer](examples/video_consumer_example.c)** - Reference implementation

### Use Cases

- ML inference (object detection, face recognition)
- Video recording to disk
- Motion detection
- Frame analysis
- Custom video processing

### Performance

- **Latency**: <1ms (vs ~50-100ms for WebSocket)
- **CPU**: <1% overhead
- **Memory**: ~15MB shared buffer
- **Throughput**: 30 fps @ 1080p
- **Multiple readers**: Supported

## Accessing the Stream

1. **Web Browser**: Navigate to `http://<device-ip>/#/overview`
2. **Direct WebSocket**: Connect to `ws://<device-ip>:8765`

The overview page in the Supervisor UI will automatically connect and display the video stream.

## Protocol

Each WebSocket message contains:
- **Binary data**: H.264 encoded video frame
- **Last 8 bytes**: Little-endian uint64 timestamp in milliseconds

Frontend uses jmuxer to decode H.264 and calculate display latency.

## Troubleshooting

### No video in browser
- Check if camera-streamer is running: `ps aux | grep camera-streamer`
- Verify WebSocket port is open: `netstat -tuln | grep 8765`
- Check browser console for WebSocket errors

### Poor video quality
- Adjust resolution/framerate in `main.cpp` (default: 1920x1080@30fps)
- Rebuild and reinstall

### High latency
- Check network connection
- Ensure device has sufficient resources (CPU/memory)
- Reduce resolution or framerate if needed

## Integration with Go Supervisor

The camera-streamer is designed to work alongside the Go supervisor:
- Supervisor provides the web UI and APIs
- Camera-streamer handles video streaming
- Both services run independently but cooperate

See [`solutions/supervisor/`](../supervisor/) for supervisor implementation.

## Technical Details

### Components Used
- **Sophgo Video SDK**: Camera capture and H.264 encoding
- **Mongoose**: Lightweight WebSocket server
- **Video**: Low-level video subsystem API

### Video Configuration
- Format: H.264
- Resolution: 1920x1080
- Frame Rate: 30 FPS
- Channel: VIDEO_CH2

### Performance
- Low CPU usage (<10% on SG200X)
- ~100ms latency (device to browser)
- ~2-4 Mbps bitrate (depends on scene complexity)

## License

Same as parent project.
