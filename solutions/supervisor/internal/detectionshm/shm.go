// Package detectionshm provides pure Go shared memory consumer for detection queue.
// Uses POSIX shared memory for zero-copy IPC with camera-detector.
package detectionshm

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"

	"supervisor/internal/cameradb"
	"supervisor/internal/detectionqueue"
	"supervisor/internal/security"
	"supervisor/pkg/logger"
)

// Shared memory constants - must match detection_shm.h
const (
	shmName       = "/detection_queue"
	maxPerFrame   = 10
	imagePathSize = 128 // Path to JPEG file on disk
	ringSize      = 16
	shmMagic      = 0x44455451 // "DETQ"
	shmVersion    = 1
	classLabelSize = 32
	queueDir       = "/userdata/detection_queue"
)

// Offsets and sizes for C struct layout (must match detection_shm.h)
const (
	// detection_object_t size: 1 + 3 padding + 4 (float) + 16 (4 floats) + 32 = 56 bytes
	detectionObjectSize = 56

	// detection_slot_t layout:
	// - frame_timestamp_ms: 8 bytes at offset 0
	// - frame_hash: 32 bytes at offset 8
	// - num_detections: 1 byte at offset 40
	// - reserved: 7 bytes at offset 41
	// - detections[10]: 10 * 56 = 560 bytes at offset 48
	// - image_size: 4 bytes at offset 608
	// - image_path: 128 bytes at offset 612 (path to JPEG on disk)
	// - sequence: 4 bytes at offset 740
	// - valid: 1 byte at offset 744
	// - slot_reserved: 3 bytes at offset 745
	// - padding: 4 bytes at offset 748 (for 8-byte alignment due to uint64_t)
	// Total: 752 bytes (must be multiple of 8 for struct alignment)
	slotTimestampOff   = 0
	slotFrameHashOff   = 8
	slotNumDetOff      = 40
	slotDetectionsOff  = 48
	slotImageSizeOff   = 608
	slotImagePathOff   = 612
	slotSequenceOff    = 740
	slotValidOff       = 744
	slotSize           = 752  // 748 + 4 padding for 8-byte alignment

	// detection_shm_t header layout:
	// - magic: 4 bytes at offset 0
	// - version: 4 bytes at offset 4
	// - write_idx: 4 bytes at offset 8
	// - read_idx: 4 bytes at offset 12
	// - frame_count: 4 bytes at offset 16
	// - dropped_frames: 4 bytes at offset 20
	// - active_readers: 4 bytes at offset 24
	// - reserved[9]: 36 bytes at offset 28
	// Total header: 64 bytes
	headerSize = 64
	slotsOff   = 64

	// Total shared memory size: header + 16 slots
	// 64 + (16 * 752) = 12096 bytes
	totalShmSize = headerSize + (ringSize * slotSize)
)

// Detection represents a single detection from the shared memory
type Detection struct {
	ClassID    uint8   `json:"class_id"`
	Confidence float32 `json:"confidence"`
	BBox       [4]float32 `json:"bbox"` // x, y, w, h normalized
	ClassLabel string  `json:"class_label"`
}

// DetectionSlot represents a complete detection slot from shared memory
type DetectionSlot struct {
	FrameTimestampMs uint64
	FrameHash        [32]byte
	NumDetections    uint8
	Detections       []Detection
	ImageSize        uint32
	ImagePath        string  // Path to JPEG file on disk
	Sequence         uint32
	Valid            bool
}

// Consumer reads detections from shared memory
type Consumer struct {
	fd           int
	data         []byte
	lastSequence uint32
	running      atomic.Bool
	mu           sync.Mutex
}

// Stats holds consumer statistics
type Stats struct {
	TotalRead    uint64 `json:"total_read"`
	Dropped      uint64 `json:"dropped"`
	Missed       uint64 `json:"missed"`
	LastReadTime int64  `json:"last_read_time"`
}

// NewConsumer creates a new shared memory consumer
func NewConsumer() (*Consumer, error) {
	c := &Consumer{
		fd: -1,
	}

	// Open shared memory via /dev/shm (POSIX shm is backed by tmpfs)
	shmPath := "/dev/shm" + shmName
	fd, err := unix.Open(shmPath, unix.O_RDONLY, 0)
	if err != nil {
		return nil, fmt.Errorf("open(%s) failed: %w (is camera-detector running?)", shmPath, err)
	}
	c.fd = fd

	// Map shared memory
	data, err := unix.Mmap(fd, 0, totalShmSize, unix.PROT_READ, unix.MAP_SHARED)
	if err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("mmap failed: %w", err)
	}
	c.data = data

	// Validate magic and version
	magic := binary.LittleEndian.Uint32(data[0:4])
	if magic != shmMagic {
		unix.Munmap(data)
		unix.Close(fd)
		return nil, fmt.Errorf("invalid magic: 0x%08X (expected 0x%08X)", magic, shmMagic)
	}

	version := binary.LittleEndian.Uint32(data[4:8])
	if version != shmVersion {
		unix.Munmap(data)
		unix.Close(fd)
		return nil, fmt.Errorf("version mismatch: %d (expected %d)", version, shmVersion)
	}

	// Start at current write position
	c.lastSequence = binary.LittleEndian.Uint32(data[16:20]) // frame_count

	logger.Info("Detection SHM consumer initialized: shm=%s, starting_seq=%d", shmName, c.lastSequence)

	return c, nil
}

// TryRead attempts to read a detection without blocking
func (c *Consumer) TryRead() (*DetectionSlot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.data == nil {
		return nil, fmt.Errorf("consumer not initialized")
	}

	// Check if new detection available
	currentCount := binary.LittleEndian.Uint32(c.data[16:20]) // frame_count

	if currentCount == c.lastSequence {
		return nil, nil // No new detection
	}

	// Check for overflow - if we're too far behind, skip to recent
	behind := currentCount - c.lastSequence
	if behind > ringSize {
		// We've fallen too far behind, skip to most recent
		logger.Warning("Detection consumer fell behind by %d, skipping to recent", behind)
		c.lastSequence = currentCount - ringSize + 1
	}

	// Calculate read position - read the next unread slot
	readIdx := c.lastSequence % ringSize
	slot := c.readSlot(readIdx)

	logger.Debug("Detection SHM read: seq=%d idx=%d valid=%v path=%s",
		slot.Sequence, readIdx, slot.Valid, slot.ImagePath)

	// Increment by 1 to read sequentially (don't jump to currentCount)
	c.lastSequence++

	return slot, nil
}

// Wait waits for the next detection with timeout using polling
func (c *Consumer) Wait(timeout time.Duration) (*DetectionSlot, error) {
	if c.data == nil {
		return nil, fmt.Errorf("consumer not initialized")
	}

	// Poll for new data at 10ms intervals
	pollInterval := 10 * time.Millisecond
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		slot, err := c.TryRead()
		if err != nil {
			return nil, err
		}
		if slot != nil {
			return slot, nil
		}
		time.Sleep(pollInterval)
	}

	return nil, nil // Timeout
}

// readSlot reads a slot from the ring buffer
func (c *Consumer) readSlot(idx uint32) *DetectionSlot {
	slotOff := slotsOff + (int(idx) * slotSize)
	slot := &DetectionSlot{}

	// Read frame timestamp
	slot.FrameTimestampMs = binary.LittleEndian.Uint64(c.data[slotOff+slotTimestampOff : slotOff+slotTimestampOff+8])

	// Read frame hash
	copy(slot.FrameHash[:], c.data[slotOff+slotFrameHashOff:slotOff+slotFrameHashOff+32])

	// Read num detections
	slot.NumDetections = c.data[slotOff+slotNumDetOff]
	if slot.NumDetections > maxPerFrame {
		slot.NumDetections = maxPerFrame
	}

	// Read detections
	slot.Detections = make([]Detection, slot.NumDetections)
	for i := uint8(0); i < slot.NumDetections; i++ {
		detOff := slotOff + slotDetectionsOff + (int(i) * detectionObjectSize)
		det := &slot.Detections[i]

		det.ClassID = c.data[detOff]
		det.Confidence = *(*float32)(unsafe.Pointer(&c.data[detOff+4]))
		det.BBox[0] = *(*float32)(unsafe.Pointer(&c.data[detOff+8]))
		det.BBox[1] = *(*float32)(unsafe.Pointer(&c.data[detOff+12]))
		det.BBox[2] = *(*float32)(unsafe.Pointer(&c.data[detOff+16]))
		det.BBox[3] = *(*float32)(unsafe.Pointer(&c.data[detOff+20]))

		// Read null-terminated class label
		labelBytes := c.data[detOff+24 : detOff+24+classLabelSize]
		for j, b := range labelBytes {
			if b == 0 {
				det.ClassLabel = string(labelBytes[:j])
				break
			}
		}
		if det.ClassLabel == "" && labelBytes[0] != 0 {
			det.ClassLabel = string(labelBytes)
		}
	}

	// Read image size
	slot.ImageSize = binary.LittleEndian.Uint32(c.data[slotOff+slotImageSizeOff : slotOff+slotImageSizeOff+4])

	// Read image path (null-terminated string)
	pathBytes := c.data[slotOff+slotImagePathOff : slotOff+slotImagePathOff+imagePathSize]
	for j, b := range pathBytes {
		if b == 0 {
			slot.ImagePath = string(pathBytes[:j])
			break
		}
	}
	if slot.ImagePath == "" && pathBytes[0] != 0 {
		slot.ImagePath = string(pathBytes)
	}

	// Read sequence and valid flag
	slot.Sequence = binary.LittleEndian.Uint32(c.data[slotOff+slotSequenceOff : slotOff+slotSequenceOff+4])
	slot.Valid = c.data[slotOff+slotValidOff] != 0

	return slot
}

// GetStats returns consumer statistics
func (c *Consumer) GetStats() Stats {
	c.mu.Lock()
	defer c.mu.Unlock()

	stats := Stats{}
	if c.data != nil {
		stats.TotalRead = uint64(binary.LittleEndian.Uint32(c.data[16:20]))
		stats.Dropped = uint64(binary.LittleEndian.Uint32(c.data[20:24]))
	}
	return stats
}

// Close releases consumer resources
func (c *Consumer) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.data != nil {
		unix.Munmap(c.data)
		c.data = nil
	}

	if c.fd >= 0 {
		unix.Close(c.fd)
		c.fd = -1
	}

	return nil
}

// ConsumerLoop runs the detection consumer in a goroutine
type ConsumerLoop struct {
	consumer *Consumer
	uploader *detectionqueue.Uploader
	running  atomic.Bool
	wg       sync.WaitGroup
}

// NewConsumerLoop creates a new consumer loop
func NewConsumerLoop(uploader *detectionqueue.Uploader) *ConsumerLoop {
	return &ConsumerLoop{
		uploader: uploader,
	}
}

// Start begins the consumer loop
func (cl *ConsumerLoop) Start(ctx context.Context) error {
	logger.Info("Detection SHM consumer starting...")

	// Try to connect to shared memory (may fail if detector not running)
	consumer, err := NewConsumer()
	if err != nil {
		// Not an error - detector may not be running yet
		logger.Info("Detection SHM not available yet: %v", err)
		logger.Info("Starting retry loop to wait for detector...")
		// Start a goroutine to retry connection
		cl.wg.Add(1)
		go cl.retryLoop(ctx)
		return nil
	}

	cl.consumer = consumer
	cl.running.Store(true)
	cl.wg.Add(1)
	go cl.readLoop(ctx)

	return nil
}

// retryLoop tries to connect to shared memory until successful
func (cl *ConsumerLoop) retryLoop(ctx context.Context) {
	defer cl.wg.Done()

	logger.Info("Detection SHM retry loop started, checking every 5s...")

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			logger.Info("Detection SHM retry loop cancelled")
			return
		case <-ticker.C:
			consumer, err := NewConsumer()
			if err != nil {
				logger.Info("Detection SHM retry: still not available: %v", err)
				logger.Debug("Detection SHM still not available: %v", err)
				continue
			}

			cl.consumer = consumer
			cl.running.Store(true)
			cl.wg.Add(1)
			go cl.readLoop(ctx)
			return
		}
	}
}

// readLoop reads detections from shared memory
func (cl *ConsumerLoop) readLoop(ctx context.Context) {
	defer cl.wg.Done()
	defer cl.consumer.Close()

	logger.Info("Detection SHM consumer loop started")

	loopCount := 0
	for cl.running.Load() {
		loopCount++
		select {
		case <-ctx.Done():
			cl.running.Store(false)
			return
		default:
		}

		// Wait for detection with 1 second timeout
		slot, err := cl.consumer.Wait(time.Second)
		if err != nil {
			logger.Error("Detection SHM read error: %v", err)
			continue
		}

		if slot == nil {
			// Log every 10 iterations to show loop is alive
			if loopCount%10 == 0 {
				logger.Debug("Detection SHM: waiting for detections (loop=%d)", loopCount)
			}
			continue // Timeout or no new data
		}

		logger.Info("Detection SHM: got slot valid=%v seq=%d numDet=%d path=%s",
			slot.Valid, slot.Sequence, slot.NumDetections, slot.ImagePath)

		if !slot.Valid {
			logger.Warning("Detection SHM: skipping invalid slot (seq=%d)", slot.Sequence)
			continue
		}

		// Process the detection
		logger.Info("Detection SHM: processing detection seq=%d", slot.Sequence)
		if err := cl.processDetection(slot); err != nil {
			logger.Error("Failed to process detection: %v", err)
		}
		logger.Info("Detection SHM: finished processing seq=%d", slot.Sequence)
	}

	logger.Info("Detection SHM consumer loop stopped")
}

// processDetection handles a detection from shared memory
func (cl *ConsumerLoop) processDetection(slot *DetectionSlot) error {
	// Debug: log what we received
	logger.Info("DEBUG: Detection received - seq=%d, numDet=%d, imageSize=%d, path=%s",
		slot.Sequence, slot.NumDetections, slot.ImageSize, slot.ImagePath)

	// Image is already on disk (written by camera-detector)
	imagePath := slot.ImagePath
	if imagePath == "" {
		return fmt.Errorf("no image path in detection slot")
	}

	// Verify image file exists
	if _, err := os.Stat(imagePath); os.IsNotExist(err) {
		return fmt.Errorf("image file not found: %s", imagePath)
	}

	// Generate unique ID from filename
	id := filepath.Base(imagePath)
	id = id[:len(id)-4] // Remove .jpg extension

	// Convert detections to percentage confidence for platform API
	// The model outputs 0-1, but the platform expects 0-100
	detectionsForAPI := make([]Detection, len(slot.Detections))
	for i, det := range slot.Detections {
		detectionsForAPI[i] = Detection{
			ClassID:    det.ClassID,
			Confidence: det.Confidence * 100, // Convert to percentage
			BBox:       det.BBox,
			ClassLabel: det.ClassLabel,
		}
	}

	// Build detections JSON
	detectionsJSON, err := json.Marshal(detectionsForAPI)
	if err != nil {
		os.Remove(imagePath)
		return fmt.Errorf("failed to marshal detections: %w", err)
	}

	// Get primary detection (first one with highest confidence)
	var primaryClass string
	var primaryConfidence float64
	var primaryBBox string
	if len(slot.Detections) > 0 {
		det := slot.Detections[0]
		primaryClass = det.ClassLabel
		primaryConfidence = float64(det.Confidence) * 100 // Convert to percentage
		// Convert normalized bbox to JSON array
		bbox, _ := json.Marshal(det.BBox[:])
		primaryBBox = string(bbox)
	}

	// Determine capture time - validate timestamp is reasonable (year 2000-2100)
	// Invalid/garbage timestamps cause JSON marshaling errors
	const (
		minValidMs = 946684800000  // 2000-01-01
		maxValidMs = 4102444800000 // 2100-01-01
	)
	var captureTime time.Time
	if slot.FrameTimestampMs >= minValidMs && slot.FrameTimestampMs <= maxValidMs {
		captureTime = time.UnixMilli(int64(slot.FrameTimestampMs))
	} else {
		captureTime = time.Now()
		if slot.FrameTimestampMs != 0 {
			logger.Debug("Invalid frame timestamp %d, using current time", slot.FrameTimestampMs)
		}
	}

	// Determine TSA status
	tsaStatus := "skipped"
	frameHash := ""

	if security.EvidenceChainEnabled() {
		// Check if frame hash is non-zero
		nonZero := false
		for _, b := range slot.FrameHash {
			if b != 0 {
				nonZero = true
				break
			}
		}
		if nonZero && slot.FrameTimestampMs > 0 {
			frameHash = hex.EncodeToString(slot.FrameHash[:])
			tsaStatus = "pending"
		}
	}

	// Create queue item
	item := detectionqueue.DetectionItem{
		ID:              id,
		ImagePath:       imagePath,
		BoundingBox:     primaryBBox,
		ClassLabel:      primaryClass,
		ConfidenceScore: primaryConfidence,
		Detections:      string(detectionsJSON),
		Timestamp:       captureTime,
		RetryCount:      0,
		FrameHash:       frameHash,
		TSAStatus:       tsaStatus,
	}

	// Enqueue for upload
	if err := cl.uploader.Enqueue(item); err != nil {
		os.Remove(imagePath)
		return fmt.Errorf("failed to enqueue: %w", err)
	}

	// Write detections to cameradb for correlation with recordings
	frameTsMs := int64(slot.FrameTimestampMs)
	if frameTsMs == 0 {
		frameTsMs = captureTime.UnixMilli()
	}

	// Find recording that contains this timestamp
	var recordingID int64
	if rec, err := cameradb.FindRecordingForTimestamp(frameTsMs); err == nil && rec != nil {
		recordingID = rec.ID
	}

	// Insert each detection into the database
	for _, det := range slot.Detections {
		dbDet := &cameradb.Detection{
			FrameTsMs:   frameTsMs,
			ClassID:     int(det.ClassID),
			ClassLabel:  det.ClassLabel,
			Confidence:  float64(det.Confidence),
			BboxX:       float64(det.BBox[0]),
			BboxY:       float64(det.BBox[1]),
			BboxW:       float64(det.BBox[2]),
			BboxH:       float64(det.BBox[3]),
			ImagePath:   imagePath,
			RecordingID: recordingID,
		}
		if _, err := cameradb.InsertDetection(dbDet); err != nil {
			logger.Warning("Failed to insert detection to DB: %v", err)
		}
	}

	logger.Info("Detection received: class=%s confidence=%.1f%% queued=%s",
		primaryClass, primaryConfidence*100, id)

	return nil
}

// Stop stops the consumer loop
func (cl *ConsumerLoop) Stop() {
	cl.running.Store(false)
	cl.wg.Wait()
}

