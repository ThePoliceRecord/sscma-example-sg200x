/**
 * @file detection_shm_producer.hpp
 * @brief Shared memory producer for detection queue
 *
 * Writes detections to shared memory ring buffer for supervisor to consume.
 * Zero-copy IPC replaces HTTP-based detection sending.
 */

#ifndef DETECTION_SHM_PRODUCER_HPP
#define DETECTION_SHM_PRODUCER_HPP

#include <string>
#include <vector>
#include <cstdint>
#include <cstring>

extern "C" {
#include "detection_shm.h"
}

/**
 * Frame evidence metadata for trusted timestamps
 */
struct FrameEvidence {
    uint64_t timestamp_ms;              // Capture timestamp from camera
    uint8_t frame_hash[32];             // SHA256 of raw frame data
    bool valid;                         // True if NTP was synced at capture time

    FrameEvidence() : timestamp_ms(0), valid(false) {
        memset(frame_hash, 0, sizeof(frame_hash));
    }
};

/**
 * Detection bounding box with metadata
 */
struct Detection {
    int class_id;
    std::string class_label;
    float confidence;
    float x, y, w, h;  // Normalized 0-1
};

/**
 * DetectionShmProducer writes detections to shared memory
 * for the supervisor to consume and upload to the platform.
 */
class DetectionShmProducer {
public:
    /**
     * Constructor - initializes shared memory producer
     */
    DetectionShmProducer();
    ~DetectionShmProducer();

    /**
     * Check if producer is initialized
     */
    bool isInitialized() const { return m_initialized; }

    /**
     * Send detection with JPEG-encoded frame to shared memory
     * @param bgr_data BGR888 frame data (from VPSS, converted to RGB internally)
     * @param width Frame width
     * @param height Frame height
     * @param detections Vector of detections to send
     * @param evidence Frame evidence metadata (timestamp, hash) for trusted timestamps
     * @return true if successfully written to shm, false on error or dropped
     */
    bool send(const uint8_t* bgr_data, int width, int height,
              const std::vector<Detection>& detections,
              const FrameEvidence& evidence = FrameEvidence());

    /**
     * Set JPEG encoding quality
     * @param quality JPEG quality (1-100, default 100)
     */
    void setJpegQuality(int quality);

    /**
     * Get number of successful writes
     */
    uint32_t getSentCount() const { return m_sent_count; }

    /**
     * Get number of dropped writes (buffer full)
     */
    uint32_t getDroppedCount() const { return m_dropped_count; }

    /**
     * Get number of failed writes (errors)
     */
    uint32_t getFailedCount() const { return m_failed_count; }

private:
    detection_producer_t m_producer;
    bool m_initialized;
    std::vector<uint8_t> m_jpeg_buffer;
    int m_jpeg_quality;
    uint32_t m_sent_count;
    uint32_t m_dropped_count;
    uint32_t m_failed_count;

    /**
     * Encode BGR frame to JPEG (converts to RGB internally)
     * @param bgr_data BGR888 frame data from VPSS
     * @param width Frame width
     * @param height Frame height
     * @return Size of encoded JPEG, 0 on failure
     */
    size_t encodeJpeg(const uint8_t* bgr_data, int width, int height);
};

#endif // DETECTION_SHM_PRODUCER_HPP
