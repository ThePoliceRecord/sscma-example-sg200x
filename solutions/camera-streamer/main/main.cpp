#include <chrono>
#include <iostream>
#include <set>
#include <queue>
#include <mutex>
#include <string.h>
#include <signal.h>
#include <unistd.h>

extern "C" {
#include "video.h"
#include "mongoose.h"
}

#define TAG "camera-streamer"
#define WS_PORT "8765"
#define MAX_QUEUE_SIZE 30  // Drop frames if queue gets too large

static volatile bool g_running = true;
static struct mg_mgr g_mgr;
static std::set<struct mg_connection*> g_ws_clients;
static std::queue<std::pair<uint8_t*, size_t>> g_frame_queue;
static std::mutex g_clients_mutex;
static std::mutex g_queue_mutex;

// Signal handler for graceful shutdown
static void signal_handler(int signo) {
    if (signo == SIGINT || signo == SIGTERM) {
        printf("%s: Received signal %d, shutting down...\n", TAG, signo);
        g_running = false;
    }
}

// WebSocket event handler
static void ws_handler(struct mg_connection *c, int ev, void *ev_data) {
    if (ev == MG_EV_HTTP_MSG) {
        struct mg_http_message *hm = (struct mg_http_message *) ev_data;
        if (mg_match(hm->uri, mg_str("/"), NULL)) {
            mg_ws_upgrade(c, hm, NULL);
        } else {
            mg_http_reply(c, 404, "", "Not Found\n");
        }
    } else if (ev == MG_EV_WS_OPEN) {
        std::lock_guard<std::mutex> lock(g_clients_mutex);
        g_ws_clients.insert(c);
        printf("%s: WebSocket client connected (%zu total)\n", TAG, g_ws_clients.size());
    } else if (ev == MG_EV_CLOSE || ev == MG_EV_ERROR) {
        std::lock_guard<std::mutex> lock(g_clients_mutex);
        auto it = g_ws_clients.find(c);
        if (it != g_ws_clients.end()) {
            g_ws_clients.erase(it);
            printf("%s: WebSocket client disconnected (%zu remaining)\n", TAG, g_ws_clients.size());
        }
    }
}

// Video frame callback - queues frames for main thread to send
static int video_frame_callback(void* pData, void* pArgs, void* pUserData) {
    VENC_STREAM_S* pstStream = (VENC_STREAM_S*)pData;
    
    if (!g_running || pstStream->u32PackCount == 0) {
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

        // Allocate buffer for frame + timestamp (8 bytes)
        size_t total_len = frame_len + 8;
        uint8_t* buffer = new uint8_t[total_len];
        
        // Copy frame data and append timestamp
        memcpy(buffer, frame_data, frame_len);
        memcpy(buffer + frame_len, &timestamp, 8);

        // Queue frame for main thread to send
        {
            std::lock_guard<std::mutex> lock(g_queue_mutex);
            if (g_frame_queue.size() < MAX_QUEUE_SIZE) {
                g_frame_queue.push(std::make_pair(buffer, total_len));
            } else {
                // Queue full, drop frame and free buffer
                delete[] buffer;
            }
        }
    }

    return CVI_SUCCESS;
}

// Process queued frames and send to clients (called from main thread)
static void process_frame_queue() {
    std::pair<uint8_t*, size_t> frame;
    bool has_frame = false;
    
    // Get frame from queue
    {
        std::lock_guard<std::mutex> lock(g_queue_mutex);
        if (!g_frame_queue.empty()) {
            frame = g_frame_queue.front();
            g_frame_queue.pop();
            has_frame = true;
        }
    }
    
    if (!has_frame) {
        return;
    }
    
    // Send to all clients (mongoose thread-safe now!)
    {
        std::lock_guard<std::mutex> lock(g_clients_mutex);
        for (auto conn : g_ws_clients) {
            if (conn && conn->is_websocket) {
                mg_ws_send(conn, frame.first, frame.second, WEBSOCKET_OP_BINARY);
            }
        }
    }
    
    // Free buffer
    delete[] frame.first;
}

int main(int argc, char* argv[]) {
    printf("%s: Starting camera streamer on port %s\n", TAG, WS_PORT);

    // Setup signal handlers
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    // Initialize video subsystem
    printf("%s: Initializing video subsystem...\n", TAG);
    if (initVideo() != 0) {
        fprintf(stderr, "%s: Failed to initialize video\n", TAG);
        return -1;
    }

    // Configure video channel for H.264 @ 1920x1080 @ 30fps
    video_ch_param_t param;
    param.format = VIDEO_FORMAT_H264;
    param.width = 1920;
    param.height = 1080;
    param.fps = 30;
    
    printf("%s: Configuring video channel: %dx%d @ %dfps H.264\n", 
           TAG, param.width, param.height, param.fps);
    
    if (setupVideo(VIDEO_CH0, &param) != 0) {
        fprintf(stderr, "%s: Failed to setup video channel\n", TAG);
        deinitVideo();
        return -1;
    }

    // Register frame callback
    registerVideoFrameHandler(VIDEO_CH0, 0, video_frame_callback, NULL);

    // Initialize Mongoose WebSocket server
    mg_mgr_init(&g_mgr);
    char url[64];
    snprintf(url, sizeof(url), "http://0.0.0.0:%s", WS_PORT);
    
    printf("%s: Starting WebSocket server on %s\n", TAG, url);
    struct mg_connection *listen_conn = mg_http_listen(&g_mgr, url, ws_handler, NULL);
    
    if (listen_conn == NULL) {
        fprintf(stderr, "%s: Failed to start WebSocket server\n", TAG);
        deinitVideo();
        return -1;
    }

    // Start video streaming
    printf("%s: Starting video stream...\n", TAG);
    if (startVideo() != 0) {
        fprintf(stderr, "%s: Failed to start video stream\n", TAG);
        mg_mgr_free(&g_mgr);
        deinitVideo();
        return -1;
    }

    printf("%s: Camera streamer is running. Connect to ws://<device-ip>:%s\n", TAG, WS_PORT);
    printf("%s: Press Ctrl+C to stop\n", TAG);

    // Main event loop - process both mongoose events AND frame queue
    while (g_running) {
        mg_mgr_poll(&g_mgr, 10); // Poll every 10ms
        process_frame_queue();    // Send queued frames
    }

    // Cleanup
    printf("%s: Cleaning up...\n", TAG);
    
    // Clear frame queue
    {
        std::lock_guard<std::mutex> lock(g_queue_mutex);
        while (!g_frame_queue.empty()) {
            delete[] g_frame_queue.front().first;
            g_frame_queue.pop();
        }
    }
    
    deinitVideo();
    mg_mgr_free(&g_mgr);
    
    printf("%s: Shutdown complete\n", TAG);
    return 0;
}
