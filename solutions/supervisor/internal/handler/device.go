package handler

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"supervisor/internal/api"
	"supervisor/internal/device"
	"supervisor/internal/system"
	"supervisor/internal/upgrade"
	"supervisor/pkg/logger"
)

// DeviceHandler handles device management API requests.
type DeviceHandler struct {
	modelDir    string
	modelSuffix string
	deviceInfo  *device.APIDeviceInfo
	upgradeMgr  *upgrade.UpgradeManager
}

const (
	// maxOTAUploadSize limits the maximum accepted OTA zip upload size.
	// OTA zips contain a full rootfs image and can be large.
	maxOTAUploadSize int64 = 2 << 30 // 2GiB
)

// NewDeviceHandler creates a new DeviceHandler.
func NewDeviceHandler() *DeviceHandler {
	h := &DeviceHandler{
		modelDir:    "/usr/share/supervisor/models",
		modelSuffix: ".cvimodel",
		upgradeMgr:  upgrade.NewUpgradeManager(),
	}

	// Load device info
	h.deviceInfo = device.GetAPIDevice()
	if h.deviceInfo != nil {
		if h.deviceInfo.Model.Preset != "" {
			h.modelDir = h.deviceInfo.Model.Preset
		}
		if h.deviceInfo.Model.File != "" {
			ext := filepath.Ext(h.deviceInfo.Model.File)
			if ext != "" {
				h.modelSuffix = ext
			}
		}
	}

	return h
}

// QueryDeviceInfo returns device information.
func (h *DeviceHandler) QueryDeviceInfo(w http.ResponseWriter, r *http.Request) {
	info := device.QueryDeviceInfo()
	api.WriteSuccess(w, info)
}

// GetDeviceInfo returns detailed device information.
func (h *DeviceHandler) GetDeviceInfo(w http.ResponseWriter, r *http.Request) {
	info := device.QueryDeviceInfo()
	api.WriteSuccess(w, info)
}

// GetDeviceList returns list of devices on the network.
func (h *DeviceHandler) GetDeviceList(w http.ResponseWriter, r *http.Request) {
	devices, err := device.GetDeviceList()
	if err != nil {
		api.WriteSuccess(w, map[string]interface{}{"deviceList": []interface{}{}})
		return
	}
	api.WriteSuccess(w, map[string]interface{}{"deviceList": devices})
}

// UpdateDeviceNameRequest represents a device name update request.
type UpdateDeviceNameRequest struct {
	DeviceName string `json:"deviceName"`
}

// UpdateDeviceName updates the device name.
func (h *DeviceHandler) UpdateDeviceName(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		api.WriteError(w, -1, "Method not allowed")
		return
	}

	var req UpdateDeviceNameRequest
	if err := api.ParseJSONBody(r, &req); err != nil {
		api.WriteError(w, -1, "Invalid request body")
		return
	}

	if req.DeviceName == "" {
		api.WriteError(w, -1, "Device name required")
		return
	}

	// Validate device name to prevent injection attacks
	if !isValidDeviceName(req.DeviceName) {
		api.WriteError(w, -1, "Invalid device name. Use only alphanumeric characters, hyphens, and underscores (max 63 characters)")
		return
	}

	if err := device.UpdateDeviceName(req.DeviceName); err != nil {
		api.WriteError(w, -1, "Failed to update device name")
		return
	}

	api.WriteSuccess(w, map[string]interface{}{"deviceName": req.DeviceName})
}

// GetCameraWebsocketUrl returns the camera WebSocket URL (proxied through supervisor).
func (h *DeviceHandler) GetCameraWebsocketUrl(w http.ResponseWriter, r *http.Request) {
	host := r.Host

	// Determine protocol based on request scheme
	// Return supervisor's WebSocket proxy endpoint (always uses same protocol as page)
	protocol := "ws://"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		protocol = "wss://"
	}

	// Return supervisor's camera proxy endpoint (not direct camera-streamer)
	// Supervisor will relay to ws://localhost:8765
	wsURL := protocol + host + "/ws/camera"
	api.WriteSuccess(w, map[string]interface{}{"websocketUrl": wsURL})
}

// QueryServiceStatus returns the status of services.
func (h *DeviceHandler) QueryServiceStatus(w http.ResponseWriter, r *http.Request) {
	// Since sscma-node has been removed, return success status directly
	// The frontend expects sscmaNode=0 and system=0 for "RUNNING" status
	api.WriteSuccess(w, map[string]interface{}{
		"sscmaNode": 0,
		"system":    0,
		"uptime":    system.GetUptime(),
	})
}

// GetSystemStatus returns system status information.
func (h *DeviceHandler) GetSystemStatus(w http.ResponseWriter, r *http.Request) {
	// Return system status using native Go
	api.WriteSuccess(w, map[string]interface{}{
		"uptime":     system.GetUptime(),
		"deviceName": system.GetDeviceName(),
		"osName":     system.GetOSName(),
		"osVersion":  system.GetOSVersion(),
	})
}

// SetPowerRequest represents a power mode request.
type SetPowerRequest struct {
	Mode int `json:"mode"` // 0: shutdown, 1: reboot, 2: suspend
}

// SetPower sets the power mode.
func (h *DeviceHandler) SetPower(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		api.WriteError(w, -1, "Method not allowed")
		return
	}

	var req SetPowerRequest
	if err := api.ParseJSONBody(r, &req); err != nil {
		api.WriteError(w, -1, "Invalid request body")
		return
	}

	var cmd string
	switch req.Mode {
	case 0:
		cmd = "poweroff"
	case 1:
		cmd = "reboot"
	case 2:
		cmd = "suspend"
	default:
		api.WriteError(w, -1, "Invalid power mode")
		return
	}

	// Send response before executing power command
	api.WriteSuccess(w, map[string]interface{}{"mode": req.Mode})

	// Execute power command in background
	go func() {
		time.Sleep(1 * time.Second)
		exec.Command(cmd).Run()
	}()
}

// GetModelList returns the list of available models.
func (h *DeviceHandler) GetModelList(w http.ResponseWriter, r *http.Request) {
	models := []map[string]interface{}{}

	files, err := os.ReadDir(h.modelDir)
	if err != nil {
		api.WriteSuccess(w, map[string]interface{}{"models": models})
		return
	}

	for _, file := range files {
		if file.IsDir() {
			continue
		}
		name := file.Name()
		if !strings.HasSuffix(name, h.modelSuffix) {
			continue
		}

		info, err := file.Info()
		if err != nil {
			continue
		}

		models = append(models, map[string]interface{}{
			"name":     name,
			"path":     filepath.Join(h.modelDir, name),
			"size":     info.Size(),
			"modified": info.ModTime().Unix(),
		})
	}

	api.WriteSuccess(w, map[string]interface{}{"models": models})
}

// GetModelInfo returns information about the current model.
func (h *DeviceHandler) GetModelInfo(w http.ResponseWriter, r *http.Request) {
	// Read model info from file
	infoFile := device.ModelDir + "/model.json"
	data, err := os.ReadFile(infoFile)
	if err != nil {
		api.WriteError(w, -1, "Failed to get model info")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}

// GetModelFile serves a model file for download.
func (h *DeviceHandler) GetModelFile(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		api.WriteError(w, -1, "Model name required")
		return
	}

	// Sanitize path to prevent directory traversal
	// filepath.Base returns only the filename, stripping directory components
	name = filepath.Base(name)
	filePath := filepath.Join(h.modelDir, name)

	// Verify file exists and is under model directory using filepath.Rel
	// This is the CodeQL-recognized pattern for path traversal prevention
	absModelDir, err := filepath.Abs(h.modelDir)
	if err != nil {
		api.WriteError(w, -1, "Invalid model path")
		return
	}

	absPath, err := filepath.Abs(filePath)
	if err != nil {
		api.WriteError(w, -1, "Invalid model path")
		return
	}

	// Use filepath.Rel to verify the path is within modelDir
	rel, err := filepath.Rel(absModelDir, absPath)
	if err != nil {
		api.WriteError(w, -1, "Invalid model path")
		return
	}

	// Reject any path that escapes the model directory
	if rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		api.WriteError(w, -1, "Invalid model path")
		return
	}

	http.ServeFile(w, r, absPath)
}

// UploadModel handles model file uploads.
func (h *DeviceHandler) UploadModel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		api.WriteError(w, -1, "Method not allowed")
		return
	}

	// Parse multipart form
	if err := r.ParseMultipartForm(100 << 20); err != nil { // 100MB max
		api.WriteError(w, -1, "Failed to parse form")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		api.WriteError(w, -1, "File required")
		return
	}
	defer file.Close()

	// Validate filename
	filename := filepath.Base(header.Filename)
	if !strings.HasSuffix(filename, h.modelSuffix) {
		api.WriteError(w, -1, "Invalid model file type")
		return
	}

	// Create destination file
	dstPath := filepath.Join(h.modelDir, filename)
	dst, err := os.Create(dstPath)
	if err != nil {
		logger.Error("Failed to create model file: %v", err)
		api.WriteError(w, -1, "Failed to save model")
		return
	}
	defer dst.Close()

	// Copy file
	if _, err := io.Copy(dst, file); err != nil {
		logger.Error("Failed to copy model file: %v", err)
		os.Remove(dstPath)
		api.WriteError(w, -1, "Failed to save model")
		return
	}

	api.WriteSuccess(w, map[string]interface{}{
		"name": filename,
		"path": dstPath,
		"size": header.Size,
	})
}

// UploadUpdatePackage handles OTA zip uploads to stage a custom OS update.
// The uploaded file must be an "*_ota.zip" (ends with "ota.zip").
func (h *DeviceHandler) UploadUpdatePackage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		api.WriteError(w, -1, "Method not allowed")
		return
	}

	if h.upgradeMgr.IsUpgrading() {
		api.WriteError(w, -1, "Update already in progress")
		return
	}

	// Enforce an upper bound on upload size.
	r.Body = http.MaxBytesReader(w, r.Body, maxOTAUploadSize)

	// IMPORTANT: do not call r.ParseMultipartForm() for OTA packages.
	// ParseMultipartForm spills large uploads to os.TempDir() (typically /tmp), which is often too small
	// for multi-hundred-MB or multi-GB OTA zips and results in "Failed to parse form".
	// Instead, stream the multipart part directly into UpgradeTmpDir.
	reader, err := r.MultipartReader()
	if err != nil {
		logger.Error("UploadUpdatePackage: failed to create multipart reader: %v", err)
		api.WriteError(w, -1, "Invalid multipart upload")
		return
	}

	var part *multipart.Part
	for {
		p, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			logger.Error("UploadUpdatePackage: failed to read multipart data: %v", err)
			api.WriteError(w, -1, "Failed to read upload")
			return
		}
		if p.FormName() == "file" {
			part = p
			break
		}
		_ = p.Close()
	}
	if part == nil {
		api.WriteError(w, -1, "File required")
		return
	}
	defer part.Close()

	filename := filepath.Base(part.FileName())
	// Require the standard naming so the upgrader can parse version metadata.
	if !(strings.HasSuffix(filename, "ota.zip") && strings.HasSuffix(filename, ".zip")) {
		api.WriteError(w, -1, "Invalid update package type. Expected an *_ota.zip")
		return
	}

	// Ensure staging directories exist.
	if err := os.MkdirAll(upgrade.UpgradeTmpDir, 0755); err != nil {
		logger.Error("Failed to create upgrade tmp dir: %v", err)
		api.WriteError(w, -1, "Failed to stage update package")
		return
	}
	if err := os.MkdirAll(upgrade.UpgradeFilesDir, 0755); err != nil {
		logger.Error("Failed to create upgrade files dir: %v", err)
		api.WriteError(w, -1, "Failed to stage update package")
		return
	}

	// Write upload to a temp file first, then atomically rename.
	tmpDst, err := os.CreateTemp(upgrade.UpgradeTmpDir, "upload-*.partial")
	if err != nil {
		logger.Error("Failed to create temp OTA file: %v", err)
		api.WriteError(w, -1, "Failed to stage update package")
		return
	}
	tmpPath := tmpDst.Name()

	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(tmpDst, hash), part)
	closeErr := tmpDst.Close()
	if copyErr != nil || closeErr != nil {
		logger.Error("Failed to save OTA file: copyErr=%v closeErr=%v", copyErr, closeErr)
		os.Remove(tmpPath)
		api.WriteError(w, -1, "Failed to save update package")
		return
	}

	checksum := hex.EncodeToString(hash.Sum(nil))

	finalPath := filepath.Join(upgrade.UpgradeTmpDir, filename)
	// Remove any previously staged OTA with the same name.
	_ = os.Remove(finalPath)
	if err := os.Rename(tmpPath, finalPath); err != nil {
		logger.Error("Failed to finalize OTA file: %v", err)
		os.Remove(tmpPath)
		api.WriteError(w, -1, "Failed to stage update package")
		return
	}

	// Write manifest file used by the upgrader.
	manifestLine := fmt.Sprintf("%s  %s\n", checksum, filename)
	manifestPath := filepath.Join(upgrade.UpgradeFilesDir, upgrade.ChecksumFileName)
	if err := os.WriteFile(manifestPath, []byte(manifestLine), 0644); err != nil {
		logger.Error("Failed to write OTA manifest: %v", err)
		api.WriteError(w, -1, "Failed to stage update package")
		return
	}

	// Also write version.json so existing update flows can surface the staged update.
	osName := ""
	version := ""
	parts := strings.Split(filename, "_")
	if len(parts) >= 3 {
		osName = parts[1]
		version = parts[2]
	}
	versionFile := filepath.Join(upgrade.UpgradeFilesDir, "version.json")
	if data, err := json.Marshal(upgrade.UpdateVersion{OSName: osName, OSVersion: version, Status: upgrade.UpdateStatusAvailable}); err == nil {
		_ = os.WriteFile(versionFile, data, 0644)
	}

	api.WriteSuccess(w, map[string]interface{}{
		"fileName": filename,
		"checksum": checksum,
		"size":     written,
		"osName":   osName,
		"version":  version,
	})
}

// GetUploadedUpdatePackage returns information about a staged OTA package.
func (h *DeviceHandler) GetUploadedUpdatePackage(w http.ResponseWriter, r *http.Request) {
	info, err := h.upgradeMgr.GetStagedLocalPackageInfo()
	if err != nil {
		api.WriteError(w, -1, "Failed to read staged update package")
		return
	}
	api.WriteSuccess(w, info)
}

// ApplyUploadedUpdatePackage starts an upgrade using the currently staged OTA package.
func (h *DeviceHandler) ApplyUploadedUpdatePackage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		api.WriteError(w, -1, "Method not allowed")
		return
	}

	if err := h.upgradeMgr.UpdateSystemFromLocal(); err != nil {
		api.WriteError(w, -1, err.Error())
		return
	}

	api.WriteSuccess(w, map[string]interface{}{"status": "updating"})
}

// Timestamp APIs

// SetTimestampRequest represents a timestamp set request.
type SetTimestampRequest struct {
	Timestamp int64 `json:"timestamp"`
}

// SetTimestamp sets the system timestamp.
func (h *DeviceHandler) SetTimestamp(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		api.WriteError(w, -1, "Method not allowed")
		return
	}

	var req SetTimestampRequest
	if err := api.ParseJSONBody(r, &req); err != nil {
		api.WriteError(w, -1, "Invalid request body")
		return
	}

	// Set system time using date command
	t := time.Unix(req.Timestamp, 0)
	dateStr := t.Format("2006-01-02 15:04:05")
	if err := exec.Command("date", "-s", dateStr).Run(); err != nil {
		logger.Error("Failed to set timestamp: %v", err)
		api.WriteError(w, -1, "Failed to set timestamp")
		return
	}

	// Sync to hardware clock
	exec.Command("hwclock", "-w").Run()

	api.WriteSuccess(w, map[string]interface{}{"timestamp": req.Timestamp})
}

// GetTimestamp returns the current system timestamp.
func (h *DeviceHandler) GetTimestamp(w http.ResponseWriter, r *http.Request) {
	api.WriteSuccess(w, map[string]interface{}{"timestamp": time.Now().Unix()})
}

// SetTimezoneRequest represents a timezone set request.
type SetTimezoneRequest struct {
	Timezone string `json:"timezone"`
}

// SetTimezone sets the system timezone.
func (h *DeviceHandler) SetTimezone(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		api.WriteError(w, -1, "Method not allowed")
		return
	}

	var req SetTimezoneRequest
	if err := api.ParseJSONBody(r, &req); err != nil {
		api.WriteError(w, -1, "Invalid request body")
		return
	}

	if req.Timezone == "" {
		api.WriteError(w, -1, "Timezone required")
		return
	}

	// Sanitize timezone input to prevent path traversal
	// Only allow alphanumeric characters, forward slashes, underscores, hyphens, and plus signs
	// This prevents directory traversal attacks like "../../../etc/passwd"
	if !isValidTimezone(req.Timezone) {
		api.WriteError(w, -1, "Invalid timezone format")
		return
	}

	// Verify timezone exists
	tzFile := "/usr/share/zoneinfo/" + req.Timezone

	// Resolve to absolute path and verify it's under /usr/share/zoneinfo
	absPath, err := filepath.Abs(tzFile)
	if err != nil {
		api.WriteError(w, -1, "Invalid timezone")
		return
	}

	// Ensure the resolved path is still under /usr/share/zoneinfo
	if !strings.HasPrefix(absPath, "/usr/share/zoneinfo/") {
		api.WriteError(w, -1, "Invalid timezone path")
		return
	}

	if _, err := os.Stat(absPath); err != nil {
		api.WriteError(w, -1, "Invalid timezone")
		return
	}

	// Create symlink
	localtime := "/etc/localtime"
	os.Remove(localtime)
	if err := os.Symlink(absPath, localtime); err != nil {
		logger.Error("Failed to set timezone: %v", err)
		api.WriteError(w, -1, "Failed to set timezone")
		return
	}

	api.WriteSuccess(w, map[string]interface{}{"timezone": req.Timezone})
}

func isValidTimezone(tz string) bool {
	if tz == "" || len(tz) > 100 {
		return false
	}
	// Check for path traversal patterns
	if strings.Contains(tz, "..") || strings.Contains(tz, "\\") {
		return false
	}
	// Only allow safe characters for timezone paths
	for _, c := range tz {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || c == '/' || c == '_' || c == '-' || c == '+') {
			return false
		}
	}
	// Ensure it doesn't start with slash or contain double slashes
	if strings.HasPrefix(tz, "/") || strings.Contains(tz, "//") {
		return false
	}
	return true
}

// GetTimezone returns the current timezone.
func (h *DeviceHandler) GetTimezone(w http.ResponseWriter, r *http.Request) {
	link, err := os.Readlink("/etc/localtime")
	if err != nil {
		api.WriteSuccess(w, map[string]interface{}{"timezone": "UTC"})
		return
	}

	tz := strings.TrimPrefix(link, "/usr/share/zoneinfo/")
	api.WriteSuccess(w, map[string]interface{}{"timezone": tz})
}

// GetTimezoneList returns a list of available timezones.
func (h *DeviceHandler) GetTimezoneList(w http.ResponseWriter, r *http.Request) {
	timezones := []string{}

	// Read common timezones
	commonTZ := []string{
		"UTC", "America/New_York", "America/Los_Angeles", "America/Chicago",
		"Europe/London", "Europe/Paris", "Europe/Berlin",
		"Asia/Tokyo", "Asia/Shanghai", "Asia/Singapore",
		"Australia/Sydney", "Pacific/Auckland",
	}

	for _, tz := range commonTZ {
		tzFile := "/usr/share/zoneinfo/" + tz
		if _, err := os.Stat(tzFile); err == nil {
			timezones = append(timezones, tz)
		}
	}

	api.WriteSuccess(w, map[string]interface{}{"timezones": timezones})
}

// System Update APIs

// UpdateChannel sets the update channel.
func (h *DeviceHandler) UpdateChannel(w http.ResponseWriter, r *http.Request) {
	logger.Info("UpdateChannel endpoint called: method=%s", r.Method)

	if r.Method != http.MethodPost {
		logger.Warning("UpdateChannel: Method not allowed: %s", r.Method)
		api.WriteError(w, -1, "Method not allowed")
		return
	}

	var req struct {
		Channel int    `json:"channel"`
		URL     string `json:"url"`
		// Frontend sends serverUrl, so accept both for compatibility
		ServerURL string `json:"serverUrl"`
	}
	if err := api.ParseJSONBody(r, &req); err != nil {
		logger.Error("UpdateChannel: Failed to parse JSON body: %v", err)
		api.WriteError(w, -1, "Invalid request body")
		return
	}

	// Use serverUrl if url is empty (frontend sends serverUrl)
	url := req.URL
	if url == "" {
		url = req.ServerURL
	}

	logger.Info("API UpdateChannel request: channel=%d, url=%s", req.Channel, url)

	if err := h.upgradeMgr.UpdateChannel(req.Channel, url); err != nil {
		logger.Error("UpdateChannel: Failed to update channel: %v", err)
		api.WriteError(w, -1, "Failed to update channel")
		return
	}

	logger.Info("UpdateChannel: Successfully updated channel=%d", req.Channel)
	api.WriteSuccess(w, map[string]interface{}{"channel": req.Channel})
}

// GetSystemUpdateVersion returns available update version.
func (h *DeviceHandler) GetSystemUpdateVersion(w http.ResponseWriter, r *http.Request) {
	// Allow the caller to force a refresh even if version.json is cached.
	force := false
	if r.Method == http.MethodPost {
		var req struct {
			Force bool `json:"force"`
		}
		dec := json.NewDecoder(r.Body)
		if err := dec.Decode(&req); err == nil {
			force = req.Force
		} else if err != io.EOF {
			// Non-fatal: ignore malformed/empty body and fall back to cached behavior.
			logger.Warning("GetSystemUpdateVersion: failed to decode request body: %v", err)
		}
	}

	result, err := h.upgradeMgr.GetSystemUpdateVersionWithOptions(force)
	if err != nil {
		api.WriteError(w, -1, "Failed to get update version")
		return
	}
	api.WriteSuccess(w, result)
}

// GetUpdateCheckProgress returns progress/status for the "check for updates" operation.
func (h *DeviceHandler) GetUpdateCheckProgress(w http.ResponseWriter, r *http.Request) {
	result, err := h.upgradeMgr.GetUpdateCheckProgress()
	if err != nil {
		api.WriteSuccess(w, map[string]interface{}{"progress": 0, "status": "idle"})
		return
	}
	api.WriteSuccess(w, result)
}

// UpdateSystem initiates a system update.
func (h *DeviceHandler) UpdateSystem(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		api.WriteError(w, -1, "Method not allowed")
		return
	}

	// Start update in background
	go func() {
		h.upgradeMgr.UpdateSystem()
	}()

	api.WriteSuccess(w, map[string]interface{}{"status": "updating"})
}

// GetUpdateProgress returns the update progress.
func (h *DeviceHandler) GetUpdateProgress(w http.ResponseWriter, r *http.Request) {
	result, err := h.upgradeMgr.GetUpdateProgress()
	if err != nil {
		api.WriteSuccess(w, map[string]interface{}{"progress": 0, "status": "idle"})
		return
	}
	api.WriteSuccess(w, result)
}

// CancelUpdate cancels an ongoing update.
func (h *DeviceHandler) CancelUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		api.WriteError(w, -1, "Method not allowed")
		return
	}

	if err := h.upgradeMgr.CancelUpdate(); err != nil {
		api.WriteError(w, -1, "Failed to cancel update")
		return
	}

	api.WriteSuccess(w, map[string]interface{}{"status": "cancelled"})
}

// Platform Info APIs

// GetPlatformInfo returns platform configuration.
func (h *DeviceHandler) GetPlatformInfo(w http.ResponseWriter, r *http.Request) {
	info := device.GetPlatformInfo()
	api.WriteSuccess(w, map[string]interface{}{"platform_info": info})
}

// SavePlatformInfo saves platform configuration.
func (h *DeviceHandler) SavePlatformInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		api.WriteError(w, -1, "Method not allowed")
		return
	}

	var req struct {
		PlatformInfo string `json:"platform_info"`
	}
	if err := api.ParseJSONBody(r, &req); err != nil {
		api.WriteError(w, -1, "Invalid request body")
		return
	}

	if err := device.SavePlatformInfo(req.PlatformInfo); err != nil {
		api.WriteError(w, -1, "Failed to save platform info")
		return
	}

	api.WriteSuccess(w, map[string]interface{}{"message": "Platform info saved"})
}

// FactoryReset sets the factory reset flag for the next reboot.
// This will reset the device to factory defaults on next restart.
func (h *DeviceHandler) FactoryReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		api.WriteError(w, -1, "Method not allowed")
		return
	}

	// Set factory reset flag using fw_setenv
	if err := h.upgradeMgr.Recovery(); err != nil {
		logger.Error("Failed to set factory reset flag: %v", err)
		api.WriteError(w, -1, "Failed to initiate factory reset")
		return
	}

	api.WriteSuccess(w, map[string]interface{}{
		"status":  "scheduled",
		"message": "Factory reset scheduled. Please reboot the device to apply.",
	})
}

// FormatSDCard formats the SD card with exfat filesystem.
func (h *DeviceHandler) FormatSDCard(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		api.WriteError(w, -1, "Method not allowed")
		return
	}

	logger.Info("Starting SD card format")

	// SD card root device
	sdDevice := "/dev/mmcblk1"

	// Check if device exists
	if _, err := os.Stat(sdDevice); err != nil {
		logger.Error("SD card device %s not found: %v", sdDevice, err)
		api.WriteError(w, -1, "SD card not detected")
		return
	}

	// Unmount any existing mounts first
	exec.Command("umount", "-f", sdDevice+"p1").Run()
	exec.Command("umount", "-f", sdDevice).Run()
	exec.Command("umount", "-f", "/mnt/sd").Run()
	time.Sleep(500 * time.Millisecond)

	// Try to find existing partition
	cmd := exec.Command("lsblk", "-ln", "-o", "NAME", sdDevice)
	output, err := cmd.Output()
	var targetDevice string

	if err == nil {
		lines := strings.Split(strings.TrimSpace(string(output)), "\n")
		if len(lines) > 1 {
			// Found partition
			partName := strings.TrimSpace(lines[1])
			targetDevice = "/dev/" + partName
			logger.Info("Found existing partition: %s", targetDevice)
		}
	}

	// If no partition found, create one
	if targetDevice == "" {
		logger.Info("No partition found, creating partition table on %s", sdDevice)

		// Create MBR partition table with single partition using fdisk
		// Commands: o (create DOS partition table), n (new partition), p (primary),
		// 1 (partition number), default start, default end, w (write)
		fdiskScript := "o\nn\np\n1\n\n\nw\n"
		fdiskCmd := exec.Command("sh", "-c", fmt.Sprintf("echo -e '%s' | fdisk %s", fdiskScript, sdDevice))
		fdiskOutput, fdiskErr := fdiskCmd.CombinedOutput()
		logger.Info("fdisk output: %s", string(fdiskOutput))

		if fdiskErr != nil {
			logger.Warning("fdisk command had errors: %v, trying partprobe", fdiskErr)
		}

		// Tell kernel to re-read partition table
		exec.Command("partprobe", sdDevice).Run()

		// Wait for kernel to recognize new partition
		time.Sleep(2 * time.Second)

		// Confirm partition was created
		targetDevice = sdDevice + "p1"
		if _, err := os.Stat(targetDevice); err != nil {
			logger.Error("Failed to create partition %s: %v", targetDevice, err)
			api.WriteError(w, -1, "Failed to create SD card partition")
			return
		}
		logger.Info("Created partition: %s", targetDevice)
	}

	// Format with exFAT - try without -f first
	logger.Info("Formatting %s with exFAT (without -f)", targetDevice)
	cmd = exec.Command("mkfs.exfat", targetDevice)
	output, err = cmd.CombinedOutput()
	if err != nil {
		logger.Warning("mkfs.exfat without -f failed: %v, output: %s", err, string(output))

		// Try with -f flag
		logger.Info("Retrying with -f flag")
		cmd = exec.Command("mkfs.exfat", "-f", targetDevice)
		output, err = cmd.CombinedOutput()
		if err != nil {
			logger.Error("mkfs.exfat with -f failed: %v, output: %s", err, string(output))
			api.WriteError(w, -1, fmt.Sprintf("Failed to format SD card: %s", string(output)))
			return
		}
	}

	logger.Info("SD card formatted successfully with exFAT, output: %s", string(output))

	// Wait before remounting
	time.Sleep(1 * time.Second)

	// Remount the SD card with explicit filesystem type
	os.MkdirAll("/mnt/sd", 0755)
	mountCmd := exec.Command("mount", "-t", "exfat", targetDevice, "/mnt/sd")
	if mountOutput, err := mountCmd.CombinedOutput(); err != nil {
		logger.Warning("SD card formatted but failed to remount: %v, output: %s", err, string(mountOutput))
		// Don't fail the request since format was successful
	} else {
		logger.Info("SD card remounted successfully at /mnt/sd")
	}

	api.WriteSuccess(w, map[string]interface{}{
		"status":  "success",
		"message": "SD card formatted successfully with exFAT",
	})
}

// isValidDeviceName validates device/hostname according to RFC 1123
// Allows alphanumeric, hyphens (not at start/end), max 63 chars
func isValidDeviceName(name string) bool {
	if name == "" || len(name) > 63 {
		return false
	}
	// Must start and end with alphanumeric
	if !isAlphaNumeric(name[0]) || !isAlphaNumeric(name[len(name)-1]) {
		return false
	}
	// Check all characters
	for _, c := range name {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || c == '-' || c == '_') {
			return false
		}
	}
	// Check for injection patterns
	dangerous := []string{"\n", "\r", ";", "&", "|", "$", "`", "\\", "/", "<", ">", "'", "\""}
	for _, d := range dangerous {
		if strings.Contains(name, d) {
			return false
		}
	}
	return true
}

// isAlphaNumeric checks if a byte is alphanumeric
func isAlphaNumeric(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

// Analytics Configuration APIs

// AnalyticsConfig represents the analytics configuration.
type AnalyticsConfig struct {
	Enabled bool `json:"enabled"`
}

const analyticsConfigPath = "/etc/supervisor/analytics.conf"

// GetAnalyticsConfig returns the current analytics configuration.
func (h *DeviceHandler) GetAnalyticsConfig(w http.ResponseWriter, r *http.Request) {
	config, err := loadAnalyticsConfig()
	if err != nil {
		// Return default config if file doesn't exist
		config = &AnalyticsConfig{Enabled: true}
	}

	api.WriteSuccess(w, config)
}

// SetAnalyticsConfig updates the analytics configuration.
func (h *DeviceHandler) SetAnalyticsConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		api.WriteError(w, -1, "Method not allowed")
		return
	}

	var config AnalyticsConfig
	if err := api.ParseJSONBody(r, &config); err != nil {
		api.WriteError(w, -1, "Invalid request body")
		return
	}

	// Save configuration
	if err := saveAnalyticsConfig(&config); err != nil {
		logger.Error("Failed to save analytics config: %v", err)
		api.WriteError(w, -1, "Failed to save configuration")
		return
	}

	api.WriteSuccess(w, map[string]interface{}{
		"status":  "success",
		"message": "Analytics configuration saved",
		"enabled": config.Enabled,
	})
}

// loadAnalyticsConfig loads the analytics configuration from file.
func loadAnalyticsConfig() (*AnalyticsConfig, error) {
	data, err := os.ReadFile(analyticsConfigPath)
	if err != nil {
		return nil, err
	}

	var config AnalyticsConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}

	return &config, nil
}

// saveAnalyticsConfig saves the analytics configuration to file.
func saveAnalyticsConfig(config *AnalyticsConfig) error {
	// Ensure directory exists
	dir := filepath.Dir(analyticsConfigPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(analyticsConfigPath, data, 0644)
}

// Camera Re-registration API

// AACamera represents the camera registration data for Authority Alert backend.
type AACamera struct {
	SerialNumber string `json:"serial_number"`
	DeviceName   string `json:"device_name"`
	OSVersion    string `json:"os_version"`
	ModelVersion string `json:"model_version,omitempty"`
}

// ReRegisterCamera re-registers the camera with the Authority Alert service.
func (h *DeviceHandler) ReRegisterCamera(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		api.WriteError(w, -1, "Method not allowed")
		return
	}

	logger.Info("Camera re-registration requested")

	// Read API key from platform info
	platformInfo := device.GetPlatformInfo()
	if platformInfo == "" {
		logger.Error("Platform info not found - camera may not be registered yet")
		api.WriteError(w, -1, "Camera not registered. Please scan QR code first.")
		return
	}

	// Parse platform info to get API key
	var platformData map[string]interface{}
	if err := json.Unmarshal([]byte(platformInfo), &platformData); err != nil {
		logger.Error("Failed to parse platform info: %v", err)
		api.WriteError(w, -1, "Invalid platform configuration")
		return
	}

	apiKey, ok := platformData["api_key"].(string)
	if !ok || apiKey == "" {
		logger.Error("API key not found in platform info")
		api.WriteError(w, -1, "API key not found. Please scan QR code first.")
		return
	}

	// Build camera registration data
	cameraData := AACamera{
		SerialNumber: system.GetSerialNumber(),
		DeviceName:   system.GetDeviceName(),
		OSVersion:    system.GetOSVersion(),
	}

	// Call Authority Alert self-register endpoint
	if err := selfRegisterCamera(apiKey, &cameraData); err != nil {
		logger.Error("Failed to re-register camera: %v", err)
		api.WriteError(w, -1, "Failed to re-register camera: "+err.Error())
		return
	}

	logger.Info("Camera re-registered successfully")
	api.WriteSuccess(w, map[string]interface{}{
		"status":  "success",
		"message": "Camera re-registered successfully",
	})
}

// selfRegisterCamera calls the Authority Alert self-register API.
func selfRegisterCamera(apiKey string, cameraData *AACamera) error {
	// Authority Alert backend URL
	backendURL := "https://dev.thepolicerecord.com/api/v1/cameras/self-register/"

	// Marshal camera data
	jsonData, err := json.Marshal(cameraData)
	if err != nil {
		return fmt.Errorf("failed to marshal camera data: %w", err)
	}

	// Create HTTP request
	req, err := http.NewRequest("PUT", backendURL, bytes.NewBuffer(jsonData))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	// Set headers
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	// Send request
	client := &http.Client{
		Timeout: 30 * time.Second,
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	// Read response
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	// Check status code
	if resp.StatusCode != http.StatusOK {
		logger.Error("Authority Alert API returned status %d: %s", resp.StatusCode, string(body))
		return fmt.Errorf("registration failed with status %d", resp.StatusCode)
	}

	// Parse response
	var response map[string]interface{}
	if err := json.Unmarshal(body, &response); err != nil {
		logger.Warning("Failed to parse response: %v", err)
		// Don't fail if we can't parse response, as long as status was 200
	}

	logger.Info("Camera self-registration successful: %s", string(body))
	return nil
}
