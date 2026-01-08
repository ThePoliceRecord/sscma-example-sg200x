#include <iostream>
#include <signal.h>
#include <unistd.h>
#include <chrono>
#include <vector>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <getopt.h>
#include <memory>

extern "C" {
#include "video_shm.h"
#include "quirc.h"
#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
}

#define TAG "qr-reader"
#define CHANNEL_ID 2  // Read from camera-streamer channel 2 (640x480@15fps)

static volatile bool g_running = true;
static volatile bool g_cancelled = false;
static video_shm_consumer_t g_consumer;

// FFmpeg decoder context
struct H264Decoder {
    const AVCodec* codec;
    AVCodecContext* codec_ctx;
    AVFrame* frame;
    AVPacket* packet;
    bool initialized;
};

// QR code decoder context
struct QRDecoder {
    struct quirc* qr;
    bool initialized;
};

// Signal handler for graceful shutdown and cancellation
static void signal_handler(int signo) {
    if (signo == SIGINT || signo == SIGTERM) {
        fprintf(stderr, "[%s] Received signal %d, cancelling scan...\n", TAG, signo);
        g_running = false;
        g_cancelled = true;
    }
}

// Initialize H.264 decoder
static int init_h264_decoder(H264Decoder* decoder, int width, int height) {
    decoder->initialized = false;
    
    // Find H.264 decoder
    decoder->codec = avcodec_find_decoder(AV_CODEC_ID_H264);
    if (!decoder->codec) {
        fprintf(stderr, "[%s] ERROR: H.264 codec not found\n", TAG);
        return -1;
    }
    
    // Allocate codec context
    decoder->codec_ctx = avcodec_alloc_context3(decoder->codec);
    if (!decoder->codec_ctx) {
        fprintf(stderr, "[%s] ERROR: Could not allocate codec context\n", TAG);
        return -1;
    }
    
    // Set decoder parameters
    decoder->codec_ctx->width = width;
    decoder->codec_ctx->height = height;
    decoder->codec_ctx->pix_fmt = AV_PIX_FMT_YUV420P;
    
    // Open codec
    if (avcodec_open2(decoder->codec_ctx, decoder->codec, NULL) < 0) {
        fprintf(stderr, "[%s] ERROR: Could not open codec\n", TAG);
        avcodec_free_context(&decoder->codec_ctx);
        return -1;
    }
    
    // Allocate frame
    decoder->frame = av_frame_alloc();
    if (!decoder->frame) {
        fprintf(stderr, "[%s] ERROR: Could not allocate frame\n", TAG);
        avcodec_free_context(&decoder->codec_ctx);
        return -1;
    }
    
    // Allocate packet
    decoder->packet = av_packet_alloc();
    if (!decoder->packet) {
        fprintf(stderr, "[%s] ERROR: Could not allocate packet\n", TAG);
        av_frame_free(&decoder->frame);
        avcodec_free_context(&decoder->codec_ctx);
        return -1;
    }
    
    decoder->initialized = true;
    fprintf(stderr, "[%s] H.264 decoder initialized (%dx%d)\n", TAG, width, height);
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

// Initialize QR decoder
static int init_qr_decoder(QRDecoder* qr_decoder, int width, int height) {
    qr_decoder->initialized = false;
    
    qr_decoder->qr = quirc_new();
    if (!qr_decoder->qr) {
        fprintf(stderr, "[%s] ERROR: Failed to initialize quirc\n", TAG);
        return -1;
    }
    
    if (quirc_resize(qr_decoder->qr, width, height) < 0) {
        fprintf(stderr, "[%s] ERROR: Failed to resize quirc buffer to %dx%d\n", TAG, width, height);
        quirc_destroy(qr_decoder->qr);
        return -1;
    }
    
    qr_decoder->initialized = true;
    fprintf(stderr, "[%s] QR decoder initialized (%dx%d)\n", TAG, width, height);
    return 0;
}

// Cleanup QR decoder
static void cleanup_qr_decoder(QRDecoder* qr_decoder) {
    if (qr_decoder->qr) {
        quirc_destroy(qr_decoder->qr);
        qr_decoder->qr = NULL;
    }
    qr_decoder->initialized = false;
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
    
    // Prepare packet - unref first to clear any previous data
    av_packet_unref(decoder->packet);
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

// Schema validation for QR code data
static bool validate_schema(const char* data, const char* schema_name) {
    // Simple JSON format check
    if (!data || strlen(data) == 0) {
        return false;
    }
    
    if (strcmp(schema_name, "authority_config") == 0) {
        // Check for required fields in authority config
        return (strstr(data, "\"type\"") != NULL && 
                strstr(data, "authority_alert") != NULL);
    } else if (strcmp(schema_name, "wifi_config") == 0) {
        // Check for ssid field
        return (strstr(data, "\"ssid\"") != NULL);
    } else if (strcmp(schema_name, "device_pairing") == 0) {
        // Check for device_id field
        return (strstr(data, "\"device_id\"") != NULL);
    }
    
    // Unknown schema - accept any data
    return true;
}

// Escape JSON string for output
static void print_json_escaped(const char* str) {
    for (const char* p = str; *p; p++) {
        unsigned char c = (unsigned char)*p;
        switch (c) {
            case '"':  printf("\\\""); break;
            case '\\': printf("\\\\"); break;
            case '\b': printf("\\b"); break;
            case '\f': printf("\\f"); break;
            case '\n': printf("\\n"); break;
            case '\r': printf("\\r"); break;
            case '\t': printf("\\t"); break;
            default:
                // Handle control characters
                if (c < 32) {
                    printf("\\u%04x", c);
                } else {
                    printf("%c", c);
                }
                break;
        }
    }
}

// Check if QR code is already in the found list
static bool is_duplicate_qr(const std::vector<struct quirc_data>& qr_codes, const struct quirc_data* new_qr) {
    for (const auto& existing : qr_codes) {
        if (existing.payload_len == new_qr->payload_len &&
            memcmp(existing.payload, new_qr->payload, existing.payload_len) == 0) {
            return true;
        }
    }
    return false;
}

int main(int argc, char* argv[]) {
    int timeout_seconds = 30;
    int max_results = 1;
    const char* schema = NULL;
    
    // Parse command-line arguments
    static struct option long_options[] = {
        {"timeout",     required_argument, 0, 't'},
        {"max-results", required_argument, 0, 'm'},
        {"schema",      required_argument, 0, 's'},
        {"help",        no_argument,       0, 'h'},
        {0, 0, 0, 0}
    };
    
    int opt;
    int option_index = 0;
    while ((opt = getopt_long(argc, argv, "t:m:s:h", long_options, &option_index)) != -1) {
        switch (opt) {
            case 't':
                timeout_seconds = atoi(optarg);
                if (timeout_seconds <= 0) timeout_seconds = 30;
                break;
            case 'm':
                max_results = atoi(optarg);
                break;
            case 's':
                schema = optarg;
                break;
            case 'h':
                printf("Usage: %s [OPTIONS]\n", argv[0]);
                printf("Options:\n");
                printf("  --timeout <seconds>      Scan timeout (default: 30)\n");
                printf("  --max-results <count>    Maximum QR codes (default: 1, 0=unlimited)\n");
                printf("  --schema <name>          Validate against schema\n");
                printf("                           (authority_config, wifi_config, device_pairing)\n");
                printf("  --help                   Show this help\n");
                return 0;
            default:
                fprintf(stderr, "Use --help for usage information\n");
                return 2;
        }
    }
    
    // Diagnostic logging
    fprintf(stderr, "[%s] Starting scan with timeout=%ds, max_results=%d", 
            TAG, timeout_seconds, max_results);
    if (schema) {
        fprintf(stderr, ", schema=%s", schema);
    }
    fprintf(stderr, "\n");
    
    // Setup signal handlers
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    
    // Initialize consumer for channel 2
    fprintf(stderr, "[%s] Connecting to camera stream channel 2...\n", TAG);
    if (video_shm_consumer_init_channel(&g_consumer, CHANNEL_ID) != 0) {
        fprintf(stderr, "[%s] ERROR: Failed to initialize consumer\n", TAG);
        fprintf(stderr, "[%s] Is camera-streamer running?\n", TAG);
        printf("{\"success\":false,\"reason\":\"camera_init_failed\",\"error\":\"Failed to connect to video stream\"}\n");
        return 2;
    }
    
    fprintf(stderr, "[%s] Camera connected: waiting for stream info...\n", TAG);
    
    // Allocate frame buffer
    uint8_t* frame_buffer = (uint8_t*)malloc(VIDEO_SHM_MAX_FRAME_SIZE);
    if (!frame_buffer) {
        fprintf(stderr, "[%s] ERROR: Failed to allocate frame buffer\n", TAG);
        video_shm_consumer_destroy(&g_consumer);
        printf("{\"success\":false,\"reason\":\"memory_error\"}\n");
        return 2;
    }
    
    // Allocate grayscale buffer (for decoded frames)
    uint8_t* gray_buffer = (uint8_t*)malloc(640 * 480);
    if (!gray_buffer) {
        fprintf(stderr, "[%s] ERROR: Failed to allocate grayscale buffer\n", TAG);
        free(frame_buffer);
        video_shm_consumer_destroy(&g_consumer);
        printf("{\"success\":false,\"reason\":\"memory_error\"}\n");
        return 2;
    }
    
    // Initialize H.264 decoder
    H264Decoder decoder = {0};
    if (init_h264_decoder(&decoder, 640, 480) < 0) {
        fprintf(stderr, "[%s] ERROR: Failed to initialize H.264 decoder\n", TAG);
        free(gray_buffer);
        free(frame_buffer);
        video_shm_consumer_destroy(&g_consumer);
        printf("{\"success\":false,\"reason\":\"decoder_init_failed\"}\n");
        return 2;
    }
    fprintf(stderr, "[%s] H.264 decoder initialized\n", TAG);
    
    // Initialize QR decoder
    QRDecoder qr_decoder = {0};
    if (init_qr_decoder(&qr_decoder, 640, 480) < 0) {
        fprintf(stderr, "[%s] ERROR: Failed to initialize QR decoder\n", TAG);
        cleanup_h264_decoder(&decoder);
        free(gray_buffer);
        free(frame_buffer);
        video_shm_consumer_destroy(&g_consumer);
        printf("{\"success\":false,\"reason\":\"qr_decoder_init_failed\"}\n");
        return 2;
    }
    fprintf(stderr, "[%s] QR decoder initialized\n", TAG);
    
    int frame_count = 0;
    std::vector<struct quirc_data> found_qr_codes;
    auto scan_start = std::chrono::steady_clock::now();
    
    fprintf(stderr, "[%s] Scanning for QR codes...\n", TAG);
    
    // Main scanning loop
    while (g_running) {
        // Check for cancellation
        if (g_cancelled) {
            auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - scan_start).count();
            fprintf(stderr, "[%s] Scan cancelled after %d frames\n", TAG, frame_count);
            
            printf("{\"success\":false,\"reason\":\"cancelled\",\"frames_processed\":%d,\"scan_duration_ms\":%ld}\n",
                   frame_count, elapsed_ms);
            
            cleanup_qr_decoder(&qr_decoder);
            cleanup_h264_decoder(&decoder);
            free(gray_buffer);
            free(frame_buffer);
            video_shm_consumer_destroy(&g_consumer);
            return 3;
        }
        
        // Check timeout
        auto elapsed_sec = std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::steady_clock::now() - scan_start).count();
        
        if (elapsed_sec >= timeout_seconds) {
            auto elapsed_ms = elapsed_sec * 1000;
            fprintf(stderr, "[%s] Timeout after %d frames\n", TAG, frame_count);
            
            printf("{\"success\":false,\"reason\":\"timeout\",\"frames_processed\":%d,\"scan_duration_ms\":%ld}\n",
                   frame_count, elapsed_ms);
            
            cleanup_qr_decoder(&qr_decoder);
            cleanup_h264_decoder(&decoder);
            free(gray_buffer);
            free(frame_buffer);
            video_shm_consumer_destroy(&g_consumer);
            return 1;
        }
        
        video_frame_meta_t meta;
        
        // Wait for next frame (1 second timeout)
        int frame_size = video_shm_consumer_wait(&g_consumer, frame_buffer, &meta, 1000);
        
        if (frame_size < 0) {
            fprintf(stderr, "[%s] ERROR: Failed to read frame\n", TAG);
            break;
        }
        
        if (frame_size == 0) {
            // Timeout - no frame available
            continue;
        }
        
        frame_count++;
        
        // Log progress periodically
        if (frame_count % 30 == 0) {
            fprintf(stderr, "[%s] Scanning... frame %d, elapsed %.1fs\n", 
                    TAG, frame_count, (float)elapsed_sec);
        }
        
        // Process keyframes for QR code detection
        if (meta.is_keyframe) {
            // Decode H.264 frame to grayscale
            if (decode_h264_frame(&decoder, frame_buffer, frame_size, 
                                   gray_buffer, meta.width, meta.height) == 0) {
                
                // Copy image data to quirc buffer
                uint8_t* buffer = quirc_begin(qr_decoder.qr, NULL, NULL);
                if (buffer) {
                    memcpy(buffer, gray_buffer, meta.width * meta.height);
                    quirc_end(qr_decoder.qr);
                    
                    // Extract and decode QR codes
                    int count = quirc_count(qr_decoder.qr);
                    
                    for (int i = 0; i < count; i++) {
                        struct quirc_code code;
                        struct quirc_data data;
                        
                        quirc_extract(qr_decoder.qr, i, &code);
                        quirc_decode_error_t err = quirc_decode(&code, &data);
                        
                        if (err == QUIRC_SUCCESS) {
                            fprintf(stderr, "[%s] QR #%zu decoded: %d bytes\n", 
                                    TAG, found_qr_codes.size() + 1, data.payload_len);
                            
                            // Check for duplicates
                            if (is_duplicate_qr(found_qr_codes, &data)) {
                                fprintf(stderr, "[%s] Duplicate QR code, ignoring\n", TAG);
                                continue;
                            }
                            
                            // Schema validation if requested
                            if (schema) {
                                bool valid = validate_schema((char*)data.payload, schema);
                                fprintf(stderr, "[%s] Schema validation: %s %s\n", 
                                        TAG, schema, valid ? "PASS" : "FAIL");
                                
                                if (!valid) {
                                    auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                                        std::chrono::steady_clock::now() - scan_start).count();
                                    
                                    printf("{\"success\":false,\"reason\":\"validation_failed\",\"qr_data\":\"");
                                    print_json_escaped((char*)data.payload);
                                    printf("\",\"schema_expected\":\"%s\",\"frames_processed\":%d,\"detection_time_ms\":%ld}\n",
                                           schema, frame_count, elapsed_ms);
                                    
                                    cleanup_qr_decoder(&qr_decoder);
                                    cleanup_h264_decoder(&decoder);
                                    free(gray_buffer);
                                    free(frame_buffer);
                                    video_shm_consumer_destroy(&g_consumer);
                                    return 2;
                                }
                            }
                            
                            // Add to found list
                            found_qr_codes.push_back(data);
                            fprintf(stderr, "[%s] Added QR code #%zu to results\n", TAG, found_qr_codes.size());
                            
                            // Check if we've collected enough QR codes
                            if (max_results > 0 && (int)found_qr_codes.size() >= max_results) {
                                g_running = false;
                                break;
                            }
                        }
                    }
                }
            }
        }
    }
    
    // Output results
    auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - scan_start).count();
    
    if (found_qr_codes.size() > 0) {
        fprintf(stderr, "[%s] Scan complete: %zu QR code(s) in %.1fs\n", 
                TAG, found_qr_codes.size(), elapsed_ms / 1000.0);
        
        printf("{\"success\":true,\"qr_codes\":[");
        for (size_t i = 0; i < found_qr_codes.size(); i++) {
            if (i > 0) printf(",");
            printf("{\"data\":\"");
            print_json_escaped((char*)found_qr_codes[i].payload);
            printf("\",\"version\":%d,\"ecc_level\":\"%c\",\"mask\":%d,\"data_type\":%d,\"validated\":%s}",
                   found_qr_codes[i].version,
                   "MLHQ"[found_qr_codes[i].ecc_level],
                   found_qr_codes[i].mask,
                   found_qr_codes[i].data_type,
                   schema ? "true" : "false");
        }
        printf("],\"count\":%zu,\"frames_processed\":%d,\"detection_time_ms\":%ld}\n",
               found_qr_codes.size(), frame_count, elapsed_ms);
    }
    
    // Cleanup
    cleanup_qr_decoder(&qr_decoder);
    cleanup_h264_decoder(&decoder);
    free(gray_buffer);
    free(frame_buffer);
    video_shm_consumer_destroy(&g_consumer);
    
    fprintf(stderr, "[%s] Shutdown complete\n", TAG);
    return found_qr_codes.size() > 0 ? 0 : 1;
}
