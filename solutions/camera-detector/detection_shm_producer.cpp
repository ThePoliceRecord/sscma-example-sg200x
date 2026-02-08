/**
 * @file detection_shm_producer.cpp
 * @brief Shared memory producer for detection queue
 */

#include "detection_shm_producer.hpp"
#include <cstdio>
#include <cstdlib>
#include <algorithm>
#include <unistd.h>
#include <sys/stat.h>

// Use stb_image_write for JPEG encoding (bundled header-only library)
#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STBI_WRITE_NO_STDIO
#include "stb_image_write.h"

#define TAG "detection_shm_producer"

// Callback for stb_image_write to accumulate JPEG data
static void jpeg_write_callback(void* context, void* data, int size) {
    auto* buffer = static_cast<std::vector<uint8_t>*>(context);
    auto* bytes = static_cast<uint8_t*>(data);
    buffer->insert(buffer->end(), bytes, bytes + size);
}

DetectionShmProducer::DetectionShmProducer()
    : m_initialized(false)
    , m_jpeg_quality(100)
    , m_sent_count(0)
    , m_dropped_count(0)
    , m_failed_count(0)
{
    // Pre-allocate JPEG buffer (typical detection JPEGs are 50-100KB)
    m_jpeg_buffer.reserve(150 * 1024);

    // Ensure detection queue directory exists
    mkdir("/userdata/detection_queue", 0755);

    // Initialize shared memory producer
    if (detection_producer_init(&m_producer) == 0) {
        m_initialized = true;
        fprintf(stderr, "[%s] Shared memory producer initialized\n", TAG);
    } else {
        fprintf(stderr, "[%s] ERROR: Failed to initialize shared memory producer\n", TAG);
    }
}

DetectionShmProducer::~DetectionShmProducer() {
    if (m_initialized) {
        detection_producer_destroy(&m_producer);
        fprintf(stderr, "[%s] Producer destroyed: sent=%u, dropped=%u, failed=%u\n",
                TAG, m_sent_count, m_dropped_count, m_failed_count);
    }
}

void DetectionShmProducer::setJpegQuality(int quality) {
    m_jpeg_quality = std::max(1, std::min(100, quality));
}

size_t DetectionShmProducer::encodeJpeg(const uint8_t* frame_data, int width, int height) {
    m_jpeg_buffer.clear();

    // Use ImageMagick convert for JPEG encoding
    // Use m_sent_count to make temp files unique per detection (avoids race condition)
    char ppm_path[96], jpg_path[96];
    snprintf(ppm_path, sizeof(ppm_path), "/userdata/detection_queue/tmp_%d_%u.ppm", getpid(), m_sent_count);
    snprintf(jpg_path, sizeof(jpg_path), "/userdata/detection_queue/tmp_%d_%u.jpg", getpid(), m_sent_count);

    // Remove old files first
    unlink(ppm_path);
    unlink(jpg_path);

    // Write PPM
    FILE* ppm = fopen(ppm_path, "wb");
    if (!ppm) {
        fprintf(stderr, "[%s] Failed to create temp PPM\n", TAG);
        return 0;
    }
    fprintf(ppm, "P6\n%d %d\n255\n", width, height);
    fwrite(frame_data, 1, width * height * 3, ppm);
    fclose(ppm);

    // Convert using full path - .jpg extension auto-selects JPEG format
    char cmd[256];
    snprintf(cmd, sizeof(cmd), "/usr/bin/convert %s -quality %d %s",
             ppm_path, m_jpeg_quality, jpg_path);

    static bool cmd_logged = false;
    if (!cmd_logged) {
        fprintf(stderr, "[%s] Running: %s\n", TAG, cmd);
        cmd_logged = true;
    }

    int ret = system(cmd);
    unlink(ppm_path);  // Clean up PPM

    if (ret != 0) {
        fprintf(stderr, "[%s] convert failed with ret=%d\n", TAG, ret);
        return 0;
    }

    // Check if output file exists
    FILE* jpg = fopen(jpg_path, "rb");
    if (!jpg) {
        fprintf(stderr, "[%s] JPEG file not created\n", TAG);
        return 0;
    }

    fseek(jpg, 0, SEEK_END);
    size_t size = ftell(jpg);
    fseek(jpg, 0, SEEK_SET);

    // Sanity check - JPEG should be much smaller than raw
    if (size > (size_t)(width * height * 3 / 2)) {
        fprintf(stderr, "[%s] WARNING: JPEG suspiciously large: %zu bytes (expected < %d)\n",
                TAG, size, width * height * 3 / 2);
        // Check file magic to see what format it actually is
        uint8_t magic[2];
        fread(magic, 1, 2, jpg);
        fseek(jpg, 0, SEEK_SET);
        fprintf(stderr, "[%s] File magic: 0x%02x 0x%02x (JPEG should be 0xff 0xd8)\n",
                TAG, magic[0], magic[1]);
    }

    m_jpeg_buffer.resize(size);
    fread(m_jpeg_buffer.data(), 1, size, jpg);
    fclose(jpg);

    // Keep JPEG for inspection (first few only)
    static int saved_count = 0;
    if (saved_count < 3) {
        char debug_path[64];
        snprintf(debug_path, sizeof(debug_path), "/tmp/detection_%d.jpg", saved_count);
        FILE* debug = fopen(debug_path, "wb");
        if (debug) {
            fwrite(m_jpeg_buffer.data(), 1, size, debug);
            fclose(debug);
            fprintf(stderr, "[%s] Saved %s (%zu bytes)\n", TAG, debug_path, size);
        }
        saved_count++;
    }

    unlink(jpg_path);  // Clean up temp JPEG

    static bool size_logged = false;
    if (!size_logged) {
        fprintf(stderr, "[%s] JPEG encoded: %zu bytes (quality=%d)\n", TAG, size, m_jpeg_quality);
        size_logged = true;
    }

    return m_jpeg_buffer.size();
}

bool DetectionShmProducer::send(const uint8_t* bgr_data, int width, int height,
                                  const std::vector<Detection>& detections,
                                  const FrameEvidence& evidence) {
    if (!m_initialized) {
        m_failed_count++;
        return false;
    }

    if (detections.empty()) {
        return true;  // Nothing to send
    }

    // Encode frame as JPEG
    size_t jpeg_size = encodeJpeg(bgr_data, width, height);
    if (jpeg_size == 0) {
        m_failed_count++;
        return false;
    }

    // Generate unique filename and write JPEG to disk
    // Use atomic rename: write to .tmp, then rename to .jpg
    char image_path[DETECTION_IMAGE_PATH_SIZE];
    char temp_path[DETECTION_IMAGE_PATH_SIZE];
    snprintf(image_path, sizeof(image_path), "/userdata/detection_queue/det_%lu_%u.jpg",
             (unsigned long)evidence.timestamp_ms, m_sent_count);
    snprintf(temp_path, sizeof(temp_path), "/userdata/detection_queue/det_%lu_%u.tmp",
             (unsigned long)evidence.timestamp_ms, m_sent_count);

    // Write to temp file first
    FILE* jpg = fopen(temp_path, "wb");
    if (!jpg) {
        fprintf(stderr, "[%s] Failed to create temp file: %s\n", TAG, temp_path);
        m_failed_count++;
        return false;
    }
    fwrite(m_jpeg_buffer.data(), 1, jpeg_size, jpg);
    fclose(jpg);

    // Atomic rename to final path (supervisor only sees complete files)
    if (rename(temp_path, image_path) != 0) {
        fprintf(stderr, "[%s] Failed to rename %s -> %s\n", TAG, temp_path, image_path);
        unlink(temp_path);
        m_failed_count++;
        return false;
    }

    fprintf(stderr, "[%s] Detection image saved: %s (%zu bytes)\n", TAG, image_path, jpeg_size);

    // Build detection slot
    detection_slot_t slot;
    memset(&slot, 0, sizeof(slot));

    // Frame evidence
    slot.frame_timestamp_ms = evidence.timestamp_ms;
    if (evidence.valid) {
        memcpy(slot.frame_hash, evidence.frame_hash, 32);
    }

    // Detections (limit to max per frame)
    slot.num_detections = std::min(static_cast<size_t>(DETECTION_MAX_PER_FRAME), detections.size());
    for (uint8_t i = 0; i < slot.num_detections; i++) {
        const auto& det = detections[i];
        slot.detections[i].class_id = static_cast<uint8_t>(det.class_id);
        slot.detections[i].confidence = det.confidence;
        slot.detections[i].bbox[0] = det.x;
        slot.detections[i].bbox[1] = det.y;
        slot.detections[i].bbox[2] = det.w;
        slot.detections[i].bbox[3] = det.h;
        strncpy(slot.detections[i].class_label, det.class_label.c_str(),
                DETECTION_CLASS_LABEL_SIZE - 1);
        slot.detections[i].class_label[DETECTION_CLASS_LABEL_SIZE - 1] = '\0';
    }

    // Image path (file on disk, not data in shm)
    slot.image_size = static_cast<uint32_t>(jpeg_size);
    strncpy(slot.image_path, image_path, DETECTION_IMAGE_PATH_SIZE - 1);
    slot.image_path[DETECTION_IMAGE_PATH_SIZE - 1] = '\0';

    // Write to shared memory
    int result = detection_producer_write(&m_producer, &slot);
    if (result < 0) {
        fprintf(stderr, "[%s] Failed to write to shared memory\n", TAG);
        m_failed_count++;
        return false;
    } else if (result == 1) {
        // Dropped (buffer full)
        fprintf(stderr, "[%s] Detection dropped (buffer full)\n", TAG);
        m_dropped_count++;
        return false;
    }

    fprintf(stderr, "[%s] Detection sent: seq=%u path=%s\n", TAG, m_sent_count, image_path);
    m_sent_count++;
    return true;
}
