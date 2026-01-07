#include <iostream>
#include <signal.h>
#include <unistd.h>
#include <chrono>
#include <vector>
#include <cstring>
#include <cstdio>

extern "C" {
#include "video_shm.h"
#include "quirc.h"
#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
}

#define TAG "sscma-qrcode-reader"
#define CHANNEL_ID 2  // Read from camera-streamer channel 2 (640x480@15fps)

static volatile bool g_running = true;
static video_shm_consumer_t g_consumer;

// FFmpeg decoder context
struct H264Decoder {
    const AVCodec* codec;
    AVCodecContext* codec_ctx;
    AVFrame* frame;
    AVPacket* packet;
    bool initialized;
};

// Signal handler for graceful shutdown
static void signal_handler(int signo) {
    if (signo == SIGINT || signo == SIGTERM) {
        printf("%s: Received signal %d, shutting down...\n", TAG, signo);
        g_running = false;
    }
}

// Initialize H.264 decoder
static int init_h264_decoder(H264Decoder* decoder, int width, int height) {
    decoder->initialized = false;
    
    // Find H.264 decoder
    decoder->codec = avcodec_find_decoder(AV_CODEC_ID_H264);
    if (!decoder->codec) {
        fprintf(stderr, "%s: ERROR: H.264 codec not found\n", TAG);
        return -1;
    }
    
    // Allocate codec context
    decoder->codec_ctx = avcodec_alloc_context3(decoder->codec);
    if (!decoder->codec_ctx) {
        fprintf(stderr, "%s: ERROR: Could not allocate codec context\n", TAG);
        return -1;
    }
    
    // Set decoder parameters
    decoder->codec_ctx->width = width;
    decoder->codec_ctx->height = height;
    decoder->codec_ctx->pix_fmt = AV_PIX_FMT_YUV420P;
    
    // Open codec
    if (avcodec_open2(decoder->codec_ctx, decoder->codec, NULL) < 0) {
        fprintf(stderr, "%s: ERROR: Could not open codec\n", TAG);
        avcodec_free_context(&decoder->codec_ctx);
        return -1;
    }
    
    // Allocate frame
    decoder->frame = av_frame_alloc();
    if (!decoder->frame) {
        fprintf(stderr, "%s: ERROR: Could not allocate frame\n", TAG);
        avcodec_free_context(&decoder->codec_ctx);
        return -1;
    }
    
    // Allocate packet
    decoder->packet = av_packet_alloc();
    if (!decoder->packet) {
        fprintf(stderr, "%s: ERROR: Could not allocate packet\n", TAG);
        av_frame_free(&decoder->frame);
        avcodec_free_context(&decoder->codec_ctx);
        return -1;
    }
    
    decoder->initialized = true;
    printf("%s: H.264 decoder initialized (%dx%d)\n", TAG, width, height);
    return 0;
}

// Cleanup decoder
static void cleanup_h264_decoder(H264Decoder* decoder) {
    if (decoder->packet) {
        av_packet_free(&decoder->packet);
    }
    if (decoder->frame) {
        av_frame_free(&decoder->frame);
    }
    if (decoder->codec_ctx) {
        avcodec_free_context(&decoder->codec_ctx);
    }
    decoder->initialized = false;
}

// Convert YUV420P to grayscale (just copy Y plane)
static void yuv420p_to_grayscale(const AVFrame* frame, uint8_t* gray_data, int width, int height) {
    // In YUV420P format, the Y plane is the first plane and contains grayscale data
    // Simply copy the Y plane
    const uint8_t* y_plane = frame->data[0];
    int y_linesize = frame->linesize[0];
    
    for (int y = 0; y < height; y++) {
        memcpy(gray_data + y * width, y_plane + y * y_linesize, width);
    }
}

// Decode H.264 frame to grayscale
static int decode_h264_frame(H264Decoder* decoder, const uint8_t* h264_data, 
                              int h264_size, uint8_t* gray_data, int width, int height) {
    if (!decoder->initialized) {
        return -1;
    }
    
    // Prepare packet
    decoder->packet->data = (uint8_t*)h264_data;
    decoder->packet->size = h264_size;
    
    // Send packet to decoder
    int ret = avcodec_send_packet(decoder->codec_ctx, decoder->packet);
    if (ret < 0) {
        // It's ok if buffer is full, we'll try next frame
        if (ret != AVERROR(EAGAIN)) {
            fprintf(stderr, "%s: ERROR: Error sending packet to decoder: %d\n", TAG, ret);
        }
        return -1;
    }
    
    // Receive decoded frame
    ret = avcodec_receive_frame(decoder->codec_ctx, decoder->frame);
    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
        // Need more data or end of stream
        return -1;
    }
    if (ret < 0) {
        fprintf(stderr, "%s: ERROR: Error receiving frame from decoder: %d\n", TAG, ret);
        return -1;
    }
    
    // Convert YUV420P to grayscale (extract Y plane)
    yuv420p_to_grayscale(decoder->frame, gray_data, width, height);
    
    return 0;
}

// Decode QR codes from grayscale image using quirc
static int decode_qrcode(const uint8_t* gray_data, int width, int height) {
    struct quirc* qr = quirc_new();
    if (!qr) {
        fprintf(stderr, "%s: ERROR: Failed to initialize quirc\n", TAG);
        return -1;
    }

    // Resize quirc buffer to match image dimensions
    if (quirc_resize(qr, width, height) < 0) {
        fprintf(stderr, "%s: ERROR: Failed to resize quirc buffer\n", TAG);
        quirc_destroy(qr);
        return -1;
    }

    // Copy image data to quirc buffer
    uint8_t* buffer = quirc_begin(qr, NULL, NULL);
    memcpy(buffer, gray_data, width * height);
    quirc_end(qr);

    // Extract and decode QR codes
    int count = quirc_count(qr);
    int decoded = 0;
    
    for (int i = 0; i < count; i++) {
        struct quirc_code code;
        struct quirc_data data;
        
        quirc_extract(qr, i, &code);
        quirc_decode_error_t err = quirc_decode(&code, &data);
        
        if (err == QUIRC_SUCCESS) {
            printf("%s: ✓ QR Code #%d: %s\n", TAG, i + 1, data.payload);
            printf("%s:   Version: %d, ECC: %c, Mask: %d, Type: %d\n", 
                   TAG, data.version, 
                   "MLHQ"[data.ecc_level],
                   data.mask, 
                   data.data_type);
            decoded++;
        } else {
            printf("%s: ✗ QR Code #%d: Decode error: %s\n", 
                   TAG, i + 1, quirc_strerror(err));
        }
    }
    
    quirc_destroy(qr);
    return decoded;
}

int main(int argc, char* argv[]) {
    printf("%s: SSCMA QR Code Reader with H.264 Decoder (Channel %d)\n", TAG, CHANNEL_ID);
    printf("%s: Reading from camera-streamer shared memory IPC\n", TAG);
    printf("%s: QR code decoding enabled with quirc library\n", TAG);
    printf("%s: H.264 decoding enabled with FFmpeg\n", TAG);
    printf("%s:\n", TAG);
    
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
    
    // Allocate grayscale buffer (for decoded frames)
    uint8_t* gray_buffer = (uint8_t*)malloc(640 * 480);
    if (!gray_buffer) {
        fprintf(stderr, "%s: ERROR: Failed to allocate grayscale buffer\n", TAG);
        free(frame_buffer);
        video_shm_consumer_destroy(&g_consumer);
        return -1;
    }
    
    // Initialize H.264 decoder
    H264Decoder decoder = {0};
    if (init_h264_decoder(&decoder, 640, 480) < 0) {
        fprintf(stderr, "%s: ERROR: Failed to initialize H.264 decoder\n", TAG);
        free(gray_buffer);
        free(frame_buffer);
        video_shm_consumer_destroy(&g_consumer);
        return -1;
    }
    
    int frame_count = 0;
    int qrcode_detections = 0;
    int qrcode_decodes = 0;
    
    printf("%s: Waiting for video frames...\n", TAG);
    printf("%s: QR codes will be detected and decoded automatically\n", TAG);
    printf("%s: Press Ctrl+C to stop\n\n", TAG);
    
    // Main loop - read frames and decode QR codes
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
        
        // Log frame info periodically
        if (frame_count % 30 == 0) {
            printf("%s: Frame %d: size=%u bytes, %s, %ux%u@%dfps\n",
                   TAG, frame_count, meta.size,
                   meta.is_keyframe ? "KEYFRAME" : "P-frame",
                   meta.width, meta.height, meta.fps);
        }
        
        // Process keyframes for QR code detection (every 15 frames ~ 1 second at 15fps)
        if (meta.is_keyframe && frame_count % 15 == 0) {
            auto start = std::chrono::high_resolution_clock::now();
            
            // Decode H.264 frame to grayscale
            if (decode_h264_frame(&decoder, frame_buffer, frame_size, 
                                   gray_buffer, meta.width, meta.height) == 0) {
                // Decode QR codes
                int num_decoded = decode_qrcode(gray_buffer, meta.width, meta.height);
                
                auto end = std::chrono::high_resolution_clock::now();
                double elapsed = std::chrono::duration<double, std::milli>(end - start).count();
                
                if (num_decoded > 0) {
                    qrcode_detections++;
                    qrcode_decodes += num_decoded;
                    printf("%s: ═══════════════════════════════════════\n", TAG);
                    printf("%s: Decoded %d QR code(s) in %.2f ms\n", TAG, num_decoded, elapsed);
                    printf("%s: ═══════════════════════════════════════\n\n", TAG);
                } else if (frame_count % 60 == 0) {
                    printf("%s: No QR codes detected (scan time: %.2f ms)\n", TAG, elapsed);
                }
            }
        }
        
        // Print statistics every 60 frames
        if (frame_count % 60 == 0) {
            uint32_t total, dropped, missed;
            video_shm_consumer_stats(&g_consumer, &total, &dropped, &missed);
            printf("%s: Stats - Frames: %d, QR Detections: %d, QR Codes: %d, Dropped: %u, Missed: %u\n",
                   TAG, frame_count, qrcode_detections, qrcode_decodes, dropped, missed);
        }
    }
    
    // Cleanup
    printf("\n%s: Shutting down...\n", TAG);
    
    uint32_t total, dropped, missed;
    video_shm_consumer_stats(&g_consumer, &total, &dropped, &missed);
    printf("%s: Final statistics:\n", TAG);
    printf("%s:   Frames received: %d\n", TAG, frame_count);
    printf("%s:   QR code detections: %d\n", TAG, qrcode_detections);
    printf("%s:   Total QR codes decoded: %d\n", TAG, qrcode_decodes);
    printf("%s:   Total: %u, Dropped: %u, Missed: %u\n", TAG, total, dropped, missed);
    
    cleanup_h264_decoder(&decoder);
    free(gray_buffer);
    free(frame_buffer);
    video_shm_consumer_destroy(&g_consumer);
    
    printf("%s: Shutdown complete\n", TAG);
    return 0;
}
