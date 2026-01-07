#include <iostream>
#include <signal.h>
#include <unistd.h>
#include <quirc.h>
#include <chrono>
#include <vector>
#include <cstring>

extern "C" {
#include "video_shm.h"
}

// FFmpeg headers for H.264 decoding
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/imgutils.h>
#include <libswscale/swscale.h>
}

#define TAG "sscma-qrcode-reader"
#define CHANNEL_ID 2  // Read from camera-streamer channel 2 (640x480@15fps)

static volatile bool g_running = true;
static video_shm_consumer_t g_consumer;

// FFmpeg decoder context
static const AVCodec* g_codec = nullptr;
static AVCodecContext* g_codec_ctx = nullptr;
static AVFrame* g_frame = nullptr;
static AVFrame* g_frame_gray = nullptr;
static AVPacket* g_packet = nullptr;
static struct SwsContext* g_sws_ctx = nullptr;

// Signal handler for graceful shutdown
static void signal_handler(int signo) {
    if (signo == SIGINT || signo == SIGTERM) {
        printf("%s: Received signal %d, shutting down...\n", TAG, signo);
        g_running = false;
    }
}

// Initialize FFmpeg H.264 decoder
static int init_decoder(int width, int height) {
    printf("%s: Initializing H.264 decoder for %dx%d\n", TAG, width, height);
    
    // Find H.264 decoder
    g_codec = avcodec_find_decoder(AV_CODEC_ID_H264);
    if (!g_codec) {
        fprintf(stderr, "%s: ERROR: H.264 codec not found\n", TAG);
        return -1;
    }
    
    // Allocate codec context
    g_codec_ctx = avcodec_alloc_context3(g_codec);
    if (!g_codec_ctx) {
        fprintf(stderr, "%s: ERROR: Could not allocate codec context\n", TAG);
        return -1;
    }
    
    // Set codec parameters
    g_codec_ctx->width = width;
    g_codec_ctx->height = height;
    g_codec_ctx->pix_fmt = AV_PIX_FMT_YUV420P;
    
    // Open codec
    if (avcodec_open2(g_codec_ctx, g_codec, nullptr) < 0) {
        fprintf(stderr, "%s: ERROR: Could not open codec\n", TAG);
        avcodec_free_context(&g_codec_ctx);
        return -1;
    }
    
    // Allocate frames
    g_frame = av_frame_alloc();
    g_frame_gray = av_frame_alloc();
    if (!g_frame || !g_frame_gray) {
        fprintf(stderr, "%s: ERROR: Could not allocate frames\n", TAG);
        return -1;
    }
    
    // Setup grayscale frame buffer
    g_frame_gray->format = AV_PIX_FMT_GRAY8;
    g_frame_gray->width = width;
    g_frame_gray->height = height;
    av_frame_get_buffer(g_frame_gray, 0);
    
    // Allocate packet
    g_packet = av_packet_alloc();
    if (!g_packet) {
        fprintf(stderr, "%s: ERROR: Could not allocate packet\n", TAG);
        return -1;
    }
    
    printf("%s: H.264 decoder initialized\n", TAG);
    return 0;
}

// Cleanup FFmpeg resources
static void cleanup_decoder() {
    printf("%s: Cleaning up decoder...\n", TAG);
    
    if (g_sws_ctx) {
        sws_freeContext(g_sws_ctx);
        g_sws_ctx = nullptr;
    }
    
    if (g_packet) {
        av_packet_free(&g_packet);
    }
    
    if (g_frame_gray) {
        av_frame_free(&g_frame_gray);
    }
    
    if (g_frame) {
        av_frame_free(&g_frame);
    }
    
    if (g_codec_ctx) {
        avcodec_free_context(&g_codec_ctx);
    }
}

// Process H.264 frame and detect QR codes
static int process_h264_frame(const uint8_t* h264_data, uint32_t size, const video_frame_meta_t* meta) {
    // Send packet to decoder
    g_packet->data = const_cast<uint8_t*>(h264_data);
    g_packet->size = size;
    
    int ret = avcodec_send_packet(g_codec_ctx, g_packet);
    if (ret < 0) {
        fprintf(stderr, "%s: ERROR: Failed to send packet to decoder\n", TAG);
        return -1;
    }
    
    // Receive decoded frame
    ret = avcodec_receive_frame(g_codec_ctx, g_frame);
    if (ret == AVERROR(EAGAIN)) {
        // Need more data
        return 0;
    } else if (ret < 0) {
        fprintf(stderr, "%s: ERROR: Failed to receive frame from decoder\n", TAG);
        return -1;
    }
    
    // Initialize swscale context if needed
    if (!g_sws_ctx) {
        g_sws_ctx = sws_getContext(
            g_frame->width, g_frame->height, (AVPixelFormat)g_frame->format,
            g_frame_gray->width, g_frame_gray->height, AV_PIX_FMT_GRAY8,
            SWS_BILINEAR, nullptr, nullptr, nullptr);
        
        if (!g_sws_ctx) {
            fprintf(stderr, "%s: ERROR: Could not initialize swscale context\n", TAG);
            return -1;
        }
    }
    
    // Convert to grayscale
    sws_scale(g_sws_ctx, g_frame->data, g_frame->linesize, 0, g_frame->height,
              g_frame_gray->data, g_frame_gray->linesize);
    
    // Initialize Quirc for QR code detection
    struct quirc* qr = quirc_new();
    if (!qr) {
        fprintf(stderr, "%s: ERROR: Failed to initialize Quirc\n", TAG);
        return -1;
    }
    
    // Resize Quirc buffer
    if (quirc_resize(qr, g_frame_gray->width, g_frame_gray->height) < 0) {
        quirc_destroy(qr);
        fprintf(stderr, "%s: ERROR: Failed to resize Quirc buffer\n", TAG);
        return -1;
    }
    
    // Copy grayscale data to Quirc buffer
    uint8_t* buffer = quirc_begin(qr, nullptr, nullptr);
    for (int y = 0; y < g_frame_gray->height; y++) {
        memcpy(buffer + y * g_frame_gray->width,
               g_frame_gray->data[0] + y * g_frame_gray->linesize[0],
               g_frame_gray->width);
    }
    quirc_end(qr);
    
    // Detect and decode QR codes
    int count = quirc_count(qr);
    if (count > 0) {
        for (int i = 0; i < count; i++) {
            struct quirc_code code;
            struct quirc_data data;
            quirc_extract(qr, i, &code);
            
            if (quirc_decode(&code, &data) == QUIRC_SUCCESS) {
                printf("%s: QR Code detected: %s\n", TAG, data.payload);
            }
        }
    }
    
    quirc_destroy(qr);
    return 0;
}

int main(int argc, char* argv[]) {
    printf("%s: SSCMA QR Code Reader (Channel %d)\n", TAG, CHANNEL_ID);
    printf("%s: Reading from camera-streamer shared memory IPC\n", TAG);
    
    // Setup signal handlers
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    
    // Initialize consumer for channel 2
    printf("%s: Connecting to camera-streamer CH%d...\n", TAG, CHANNEL_ID);
    if (video_shm_consumer_init_channel(&g_consumer, CHANNEL_ID) != 0) {
        fprintf(stderr, "%s: ERROR: Failed to initialize consumer\n", TAG);
        fprintf(stderr, "%s: Is camera-streamer running?\n", TAG);
        return -1;
    }
    
    printf("%s: Connected to /video_stream_ch%d\n", TAG, CHANNEL_ID);
    
    // Allocate frame buffer
    uint8_t* frame_buffer = (uint8_t*)malloc(VIDEO_SHM_MAX_FRAME_SIZE);
    if (!frame_buffer) {
        fprintf(stderr, "%s: ERROR: Failed to allocate frame buffer\n", TAG);
        video_shm_consumer_destroy(&g_consumer);
        return -1;
    }
    
    bool decoder_initialized = false;
    int frame_count = 0;
    int qr_detections = 0;
    
    printf("%s: Waiting for video frames...\n", TAG);
    printf("%s: Press Ctrl+C to stop\n\n", TAG);
    
    // Main loop - read frames and detect QR codes
    while (g_running) {
        video_frame_meta_t meta;
        
        // Wait for next frame (1 second timeout)
        int frame_size = video_shm_consumer_wait(&g_consumer, frame_buffer, &meta, 1000);
        
        if (frame_size < 0) {
            fprintf(stderr, "%s: ERROR: Failed to read frame\n", TAG);
            break;
        }
        
        if (frame_size == 0) {
            // Timeout - no frame available
            continue;
        }
        
        frame_count++;
        
        // Initialize decoder on first frame
        if (!decoder_initialized) {
            if (init_decoder(meta.width, meta.height) < 0) {
                fprintf(stderr, "%s: ERROR: Failed to initialize decoder\n", TAG);
                break;
            }
            decoder_initialized = true;
        }
        
        // Process keyframes only for better performance
        if (meta.is_keyframe) {
            if (process_h264_frame(frame_buffer, frame_size, &meta) == 0) {
                qr_detections++;
            }
        }
        
        // Print statistics every 30 frames
        if (frame_count % 30 == 0) {
            uint32_t total, dropped, missed;
            video_shm_consumer_stats(&g_consumer, &total, &dropped, &missed);
            printf("%s: Frames: %d, Keyframes processed: %d, Total: %u, Dropped: %u, Missed: %u\n",
                   TAG, frame_count, qr_detections, total, dropped, missed);
        }
    }
    
    // Cleanup
    printf("\n%s: Shutting down...\n", TAG);
    
    uint32_t total, dropped, missed;
    video_shm_consumer_stats(&g_consumer, &total, &dropped, &missed);
    printf("%s: Final statistics - Total: %u, Dropped: %u, Missed: %u\n",
           TAG, total, dropped, missed);
    
    cleanup_decoder();
    free(frame_buffer);
    video_shm_consumer_destroy(&g_consumer);
    
    printf("%s: Shutdown complete\n", TAG);
    return 0;
}
