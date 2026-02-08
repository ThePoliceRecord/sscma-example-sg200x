/**
 * @file detection_shm.c
 * @brief Shared memory IPC implementation for ML detections
 */

#include "detection_shm.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <errno.h>
#include <time.h>

#define LOG_TAG "detection_shm"
#define LOG_INFO(fmt, ...) fprintf(stderr, "[%s] INFO: " fmt "\n", LOG_TAG, ##__VA_ARGS__)
#define LOG_ERROR(fmt, ...) fprintf(stderr, "[%s] ERROR: " fmt "\n", LOG_TAG, ##__VA_ARGS__)
#define LOG_DEBUG(fmt, ...) fprintf(stderr, "[%s] DEBUG: " fmt "\n", LOG_TAG, ##__VA_ARGS__)

/* ============================================================================
 * Producer Implementation
 * ============================================================================ */

int detection_producer_init(detection_producer_t* producer) {
    if (!producer) {
        LOG_ERROR("NULL producer handle");
        return -1;
    }

    memset(producer, 0, sizeof(detection_producer_t));

    /* Clean up any stale instance */
    shm_unlink(DETECTION_SHM_NAME);

    /* Create shared memory */
    producer->shm_fd = shm_open(DETECTION_SHM_NAME, O_CREAT | O_RDWR, 0666);
    if (producer->shm_fd < 0) {
        LOG_ERROR("shm_open(%s) failed: %s", DETECTION_SHM_NAME, strerror(errno));
        return -1;
    }

    /* Set size */
    size_t shm_size = sizeof(detection_shm_t);
    if (ftruncate(producer->shm_fd, shm_size) < 0) {
        LOG_ERROR("ftruncate failed: %s", strerror(errno));
        close(producer->shm_fd);
        shm_unlink(DETECTION_SHM_NAME);
        return -1;
    }

    /* Map memory */
    producer->shm = mmap(NULL, shm_size,
                         PROT_READ | PROT_WRITE, MAP_SHARED,
                         producer->shm_fd, 0);
    if (producer->shm == MAP_FAILED) {
        LOG_ERROR("mmap failed: %s", strerror(errno));
        close(producer->shm_fd);
        shm_unlink(DETECTION_SHM_NAME);
        return -1;
    }

    /* Initialize header */
    memset(producer->shm, 0, shm_size);
    producer->shm->magic = DETECTION_SHM_MAGIC;
    producer->shm->version = DETECTION_SHM_VERSION;

    /* Create semaphores */
    sem_unlink(DETECTION_SEM_WRITE_NAME);
    sem_unlink(DETECTION_SEM_READ_NAME);

    producer->sem_write = sem_open(DETECTION_SEM_WRITE_NAME, O_CREAT, 0666, 1);
    if (producer->sem_write == SEM_FAILED) {
        LOG_ERROR("sem_open(%s) failed: %s", DETECTION_SEM_WRITE_NAME, strerror(errno));
        munmap(producer->shm, shm_size);
        close(producer->shm_fd);
        shm_unlink(DETECTION_SHM_NAME);
        return -1;
    }

    producer->sem_read = sem_open(DETECTION_SEM_READ_NAME, O_CREAT, 0666, 0);
    if (producer->sem_read == SEM_FAILED) {
        LOG_ERROR("sem_open(%s) failed: %s", DETECTION_SEM_READ_NAME, strerror(errno));
        sem_close(producer->sem_write);
        sem_unlink(DETECTION_SEM_WRITE_NAME);
        munmap(producer->shm, shm_size);
        close(producer->shm_fd);
        shm_unlink(DETECTION_SHM_NAME);
        return -1;
    }

    LOG_INFO("Detection producer initialized: shm=%s, shm_size=%zu bytes, ring_size=%d slots",
             DETECTION_SHM_NAME, shm_size, DETECTION_RING_SIZE);

    /* Debug: print struct layout for Go interop verification */
    LOG_INFO("Struct layout: detection_object_t=%zu, detection_slot_t=%zu",
             sizeof(detection_object_t), sizeof(detection_slot_t));
    LOG_INFO("Slot offsets: timestamp=%zu, hash=%zu, num_det=%zu, detections=%zu",
             offsetof(detection_slot_t, frame_timestamp_ms),
             offsetof(detection_slot_t, frame_hash),
             offsetof(detection_slot_t, num_detections),
             offsetof(detection_slot_t, detections));
    LOG_INFO("Slot offsets: image_size=%zu, image_path=%zu, sequence=%zu, valid=%zu",
             offsetof(detection_slot_t, image_size),
             offsetof(detection_slot_t, image_path),
             offsetof(detection_slot_t, sequence),
             offsetof(detection_slot_t, valid));

    return 0;
}

int detection_producer_write(detection_producer_t* producer,
                              const detection_slot_t* slot) {
    if (!producer || !producer->shm || !slot) {
        LOG_ERROR("Invalid parameters");
        return -1;
    }

    /* Validate slot data */
    if (slot->num_detections > DETECTION_MAX_PER_FRAME) {
        LOG_ERROR("Too many detections: %u > %u", slot->num_detections, DETECTION_MAX_PER_FRAME);
        return -1;
    }

    /* Validate image path is set */
    if (slot->image_path[0] == '\0') {
        LOG_ERROR("Image path is empty");
        return -1;
    }

    /* Acquire write lock (non-blocking to avoid stalling detection pipeline) */
    if (sem_trywait(producer->sem_write) != 0) {
        /* Lock busy - drop detection to maintain real-time performance */
        producer->shm->dropped_frames++;
        LOG_DEBUG("Detection dropped (write lock busy), total_dropped=%u",
                  producer->shm->dropped_frames);
        return 1;  /* Dropped, not an error */
    }

    /* Get write slot */
    uint32_t idx = producer->shm->write_idx % DETECTION_RING_SIZE;
    detection_slot_t* dest = &producer->shm->slots[idx];

    /* Copy data */
    memcpy(dest, slot, sizeof(detection_slot_t));
    dest->sequence = producer->sequence++;
    dest->valid = 1;

    /* Update ring buffer state */
    producer->shm->write_idx++;
    producer->shm->frame_count++;

    /* Release write lock and signal readers */
    sem_post(producer->sem_write);
    sem_post(producer->sem_read);

    LOG_DEBUG("Detection written: seq=%u, idx=%u, detections=%u, image_size=%u",
              dest->sequence, idx, dest->num_detections, dest->image_size);

    return 0;
}

int detection_producer_stats(detection_producer_t* producer,
                              uint32_t* total_written,
                              uint32_t* dropped) {
    if (!producer || !producer->shm) {
        LOG_ERROR("Invalid producer handle");
        return -1;
    }

    if (total_written) {
        *total_written = producer->shm->frame_count;
    }

    if (dropped) {
        *dropped = producer->shm->dropped_frames;
    }

    return 0;
}

void detection_producer_destroy(detection_producer_t* producer) {
    if (!producer) return;

    LOG_INFO("Destroying detection producer: total_frames=%u, dropped=%u",
             producer->shm ? producer->shm->frame_count : 0,
             producer->shm ? producer->shm->dropped_frames : 0);

    if (producer->sem_read != SEM_FAILED && producer->sem_read != NULL) {
        sem_close(producer->sem_read);
        sem_unlink(DETECTION_SEM_READ_NAME);
    }

    if (producer->sem_write != SEM_FAILED && producer->sem_write != NULL) {
        sem_close(producer->sem_write);
        sem_unlink(DETECTION_SEM_WRITE_NAME);
    }

    if (producer->shm != MAP_FAILED && producer->shm != NULL) {
        munmap(producer->shm, sizeof(detection_shm_t));
    }

    if (producer->shm_fd >= 0) {
        close(producer->shm_fd);
        shm_unlink(DETECTION_SHM_NAME);
    }

    memset(producer, 0, sizeof(detection_producer_t));
}

/* ============================================================================
 * Consumer Implementation
 * ============================================================================ */

int detection_consumer_init(detection_consumer_t* consumer) {
    if (!consumer) {
        LOG_ERROR("NULL consumer handle");
        return -1;
    }

    memset(consumer, 0, sizeof(detection_consumer_t));

    /* Open existing shared memory */
    consumer->shm_fd = shm_open(DETECTION_SHM_NAME, O_RDWR, 0666);
    if (consumer->shm_fd < 0) {
        LOG_ERROR("shm_open(%s) failed: %s (is producer running?)",
                  DETECTION_SHM_NAME, strerror(errno));
        return -1;
    }

    /* Map memory */
    consumer->shm = mmap(NULL, sizeof(detection_shm_t),
                         PROT_READ | PROT_WRITE, MAP_SHARED,
                         consumer->shm_fd, 0);
    if (consumer->shm == MAP_FAILED) {
        LOG_ERROR("mmap failed: %s", strerror(errno));
        close(consumer->shm_fd);
        return -1;
    }

    /* Validate header */
    if (consumer->shm->magic != DETECTION_SHM_MAGIC) {
        LOG_ERROR("Invalid magic: 0x%08X (expected 0x%08X)",
                  consumer->shm->magic, DETECTION_SHM_MAGIC);
        munmap(consumer->shm, sizeof(detection_shm_t));
        close(consumer->shm_fd);
        return -1;
    }

    if (consumer->shm->version != DETECTION_SHM_VERSION) {
        LOG_ERROR("Version mismatch: %u (expected %u)",
                  consumer->shm->version, DETECTION_SHM_VERSION);
        munmap(consumer->shm, sizeof(detection_shm_t));
        close(consumer->shm_fd);
        return -1;
    }

    /* Open semaphores */
    consumer->sem_write = sem_open(DETECTION_SEM_WRITE_NAME, 0);
    if (consumer->sem_write == SEM_FAILED) {
        LOG_ERROR("sem_open(%s) failed: %s", DETECTION_SEM_WRITE_NAME, strerror(errno));
        munmap(consumer->shm, sizeof(detection_shm_t));
        close(consumer->shm_fd);
        return -1;
    }

    consumer->sem_read = sem_open(DETECTION_SEM_READ_NAME, 0);
    if (consumer->sem_read == SEM_FAILED) {
        LOG_ERROR("sem_open(%s) failed: %s", DETECTION_SEM_READ_NAME, strerror(errno));
        sem_close(consumer->sem_write);
        munmap(consumer->shm, sizeof(detection_shm_t));
        close(consumer->shm_fd);
        return -1;
    }

    /* Start reading from current position */
    consumer->last_sequence = consumer->shm->frame_count;
    consumer->reader_id = getpid();

    __sync_fetch_and_add(&consumer->shm->active_readers, 1);

    LOG_INFO("Detection consumer initialized: shm=%s, reader_id=%u, starting_seq=%u",
             DETECTION_SHM_NAME, consumer->reader_id, consumer->last_sequence);

    return 0;
}

int detection_consumer_read(detection_consumer_t* consumer,
                             detection_slot_t* slot) {
    if (!consumer || !consumer->shm || !slot) {
        LOG_ERROR("Invalid parameters");
        return -1;
    }

    /* Check if new detection available */
    uint32_t current_count = consumer->shm->frame_count;
    if (current_count == consumer->last_sequence) {
        return 0;  /* No new detection */
    }

    /* Calculate read position - get the most recent unread slot */
    uint32_t read_idx = consumer->last_sequence % DETECTION_RING_SIZE;
    const detection_slot_t* src = &consumer->shm->slots[read_idx];

    /* Verify slot is valid and has expected sequence */
    if (!src->valid) {
        /* Slot not yet written or already overwritten - skip to latest */
        consumer->last_sequence = current_count - 1;
        read_idx = (consumer->shm->write_idx - 1) % DETECTION_RING_SIZE;
        src = &consumer->shm->slots[read_idx];
    }

    /* Copy data */
    memcpy(slot, src, sizeof(detection_slot_t));

    /* Update tracking */
    uint32_t missed = current_count - consumer->last_sequence - 1;
    if (missed > 0) {
        LOG_DEBUG("Consumer %u missed %u detections", consumer->reader_id, missed);
    }
    consumer->last_sequence = current_count;

    return 1;  /* Detection read */
}

int detection_consumer_wait(detection_consumer_t* consumer,
                             detection_slot_t* slot,
                             uint32_t timeout_ms) {
    if (!consumer || !consumer->shm || !slot) {
        LOG_ERROR("Invalid parameters");
        return -1;
    }

    /* Wait for new detection signal */
    if (timeout_ms == 0) {
        /* Infinite wait */
        if (sem_wait(consumer->sem_read) != 0) {
            LOG_ERROR("sem_wait failed: %s", strerror(errno));
            return -1;
        }
    } else {
        /* Timed wait */
        struct timespec ts;
        clock_gettime(CLOCK_REALTIME, &ts);
        ts.tv_sec += timeout_ms / 1000;
        ts.tv_nsec += (timeout_ms % 1000) * 1000000;
        if (ts.tv_nsec >= 1000000000) {
            ts.tv_sec++;
            ts.tv_nsec -= 1000000000;
        }

        if (sem_timedwait(consumer->sem_read, &ts) != 0) {
            if (errno == ETIMEDOUT) {
                return 0;  /* Timeout */
            }
            LOG_ERROR("sem_timedwait failed: %s", strerror(errno));
            return -1;
        }
    }

    /* Read the detection */
    return detection_consumer_read(consumer, slot);
}

int detection_consumer_stats(detection_consumer_t* consumer,
                              uint32_t* total_frames,
                              uint32_t* dropped_frames,
                              uint32_t* missed_frames) {
    if (!consumer || !consumer->shm) {
        LOG_ERROR("Invalid consumer handle");
        return -1;
    }

    if (total_frames) {
        *total_frames = consumer->shm->frame_count;
    }

    if (dropped_frames) {
        *dropped_frames = consumer->shm->dropped_frames;
    }

    if (missed_frames) {
        uint32_t current = consumer->shm->frame_count;
        *missed_frames = (current > consumer->last_sequence) ?
                         (current - consumer->last_sequence) : 0;
    }

    return 0;
}

void detection_consumer_destroy(detection_consumer_t* consumer) {
    if (!consumer) return;

    if (consumer->shm) {
        __sync_fetch_and_sub(&consumer->shm->active_readers, 1);
        LOG_INFO("Detection consumer destroyed: reader_id=%u, last_seq=%u",
                 consumer->reader_id, consumer->last_sequence);
    }

    if (consumer->sem_read != SEM_FAILED && consumer->sem_read != NULL) {
        sem_close(consumer->sem_read);
    }

    if (consumer->sem_write != SEM_FAILED && consumer->sem_write != NULL) {
        sem_close(consumer->sem_write);
    }

    if (consumer->shm != MAP_FAILED && consumer->shm != NULL) {
        munmap(consumer->shm, sizeof(detection_shm_t));
    }

    if (consumer->shm_fd >= 0) {
        close(consumer->shm_fd);
    }

    memset(consumer, 0, sizeof(detection_consumer_t));
}
