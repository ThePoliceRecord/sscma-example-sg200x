/**
 * @file detection_shm.h
 * @brief Shared memory IPC for ML detections (Detector → Supervisor)
 *
 * Zero-copy detection transfer using POSIX shared memory and semaphores.
 * Designed for low-latency detection pipeline on SG200x platform.
 */

#ifndef DETECTION_SHM_H
#define DETECTION_SHM_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <semaphore.h>

/* Configuration */
#define DETECTION_SHM_NAME          "/detection_queue"
#define DETECTION_SEM_WRITE_NAME    "/detection_queue_sem_write"
#define DETECTION_SEM_READ_NAME     "/detection_queue_sem_read"

#define DETECTION_MAX_PER_FRAME     10       /* Max detections per frame */
#define DETECTION_IMAGE_PATH_SIZE   128      /* Max path length for image file */
#define DETECTION_RING_SIZE         16       /* 16 slots buffer */
#define DETECTION_SHM_MAGIC         0x44455451  /* "DETQ" magic number */
#define DETECTION_SHM_VERSION       1
#define DETECTION_CLASS_LABEL_SIZE  32       /* Max class label length */

/* Single detection within a frame */
typedef struct {
    uint8_t  class_id;              /* COCO class ID (0-79) */
    uint8_t  reserved[3];           /* Padding for alignment */
    float    confidence;            /* Confidence score (0.0-1.0) */
    float    bbox[4];               /* x, y, w, h normalized (0.0-1.0) */
    char     class_label[DETECTION_CLASS_LABEL_SIZE];  /* "person", "car", etc. */
} detection_object_t;

/* Detection slot - one frame's worth of detections + JPEG image */
typedef struct {
    /* Frame evidence chain */
    uint64_t frame_timestamp_ms;    /* NTP-synced capture time */
    uint8_t  frame_hash[32];        /* SHA256 of original RGB frame */

    /* Detection data */
    uint8_t  num_detections;        /* 1-10 detections per frame */
    uint8_t  reserved[7];           /* Padding for alignment */
    detection_object_t detections[DETECTION_MAX_PER_FRAME];

    /* JPEG image - stored on filesystem, path sent via shm */
    uint32_t image_size;            /* JPEG file size in bytes */
    char     image_path[DETECTION_IMAGE_PATH_SIZE];  /* Path to JPEG file */

    /* Slot metadata */
    uint32_t sequence;              /* Monotonic sequence number */
    uint8_t  valid;                 /* Slot contains valid data */
    uint8_t  slot_reserved[3];      /* Padding */
} detection_slot_t;

/* Shared memory header */
typedef struct {
    uint32_t magic;                 /* Magic number for validation */
    uint32_t version;               /* Protocol version */
    uint32_t write_idx;             /* Next write position (producer) */
    uint32_t read_idx;              /* Last read position (consumer) */
    uint32_t frame_count;           /* Total frames written (wraps at UINT32_MAX) */
    uint32_t dropped_frames;        /* Frames dropped due to buffer full */
    uint32_t active_readers;        /* Number of active consumer processes */
    uint32_t reserved[9];           /* Padding to 64 bytes header */
    detection_slot_t slots[DETECTION_RING_SIZE];
} detection_shm_t;

/* Producer handle */
typedef struct {
    int shm_fd;
    detection_shm_t* shm;
    sem_t* sem_write;
    sem_t* sem_read;
    uint32_t sequence;
} detection_producer_t;

/* Consumer handle */
typedef struct {
    int shm_fd;
    detection_shm_t* shm;
    sem_t* sem_write;
    sem_t* sem_read;
    uint32_t last_sequence;
    uint32_t reader_id;
} detection_consumer_t;

/* ============================================================================
 * Producer API (used by camera-detector in C++)
 * ============================================================================ */

/**
 * Initialize detection shared memory producer
 * Creates shared memory segment and semaphores.
 *
 * @param producer Producer handle (caller allocates)
 * @return 0 on success, -1 on error
 */
int detection_producer_init(detection_producer_t* producer);

/**
 * Write a detection to shared memory
 *
 * @param producer Producer handle
 * @param slot Detection slot with all data filled in
 * @return 0 on success, 1 if dropped (buffer full), -1 on error
 */
int detection_producer_write(detection_producer_t* producer,
                              const detection_slot_t* slot);

/**
 * Get producer statistics
 *
 * @param producer Producer handle
 * @param total_written Output: total detections written
 * @param dropped Output: detections dropped due to buffer full
 * @return 0 on success, -1 on error
 */
int detection_producer_stats(detection_producer_t* producer,
                              uint32_t* total_written,
                              uint32_t* dropped);

/**
 * Cleanup producer resources
 */
void detection_producer_destroy(detection_producer_t* producer);

/* ============================================================================
 * Consumer API (used by supervisor via Go bindings)
 * ============================================================================ */

/**
 * Initialize detection shared memory consumer
 * Opens existing shared memory segment created by producer.
 *
 * @param consumer Consumer handle (caller allocates)
 * @return 0 on success, -1 on error (e.g., producer not running)
 */
int detection_consumer_init(detection_consumer_t* consumer);

/**
 * Read next available detection (non-blocking)
 *
 * @param consumer Consumer handle
 * @param slot Output slot buffer (caller allocates)
 * @return 1 if detection read, 0 if no new detection, -1 on error
 */
int detection_consumer_read(detection_consumer_t* consumer,
                             detection_slot_t* slot);

/**
 * Wait for next detection (blocking with timeout)
 *
 * @param consumer Consumer handle
 * @param slot Output slot buffer
 * @param timeout_ms Timeout in milliseconds (0 = infinite)
 * @return 1 if detection read, 0 on timeout, -1 on error
 */
int detection_consumer_wait(detection_consumer_t* consumer,
                             detection_slot_t* slot,
                             uint32_t timeout_ms);

/**
 * Get consumer statistics
 *
 * @param consumer Consumer handle
 * @param total_frames Output: total frames written by producer
 * @param dropped_frames Output: frames dropped by producer
 * @param missed_frames Output: frames missed by this consumer
 * @return 0 on success, -1 on error
 */
int detection_consumer_stats(detection_consumer_t* consumer,
                              uint32_t* total_frames,
                              uint32_t* dropped_frames,
                              uint32_t* missed_frames);

/**
 * Cleanup consumer resources
 */
void detection_consumer_destroy(detection_consumer_t* consumer);

/* ============================================================================
 * Utility Functions
 * ============================================================================ */

/**
 * Get the size of the shared memory segment
 * Useful for Go to know how much to mmap
 */
static inline uint32_t detection_shm_size(void) {
    return sizeof(detection_shm_t);
}

/**
 * Get the size of a single detection slot
 */
static inline uint32_t detection_slot_size(void) {
    return sizeof(detection_slot_t);
}

/**
 * Get the offset to the slots array in the shared memory
 */
static inline uint32_t detection_slots_offset(void) {
    return offsetof(detection_shm_t, slots);
}

#ifdef __cplusplus
}
#endif

#endif /* DETECTION_SHM_H */
