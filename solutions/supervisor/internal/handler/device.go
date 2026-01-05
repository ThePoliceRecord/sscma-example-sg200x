package handler

import (
	"fmt"
	"io"
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
	name = filepath.Base(name)
	filePath := filepath.Join(h.modelDir, name)

	// Verify file exists and is under model directory
	absPath, err := filepath.Abs(filePath)
	if err != nil || !strings.HasPrefix(absPath, h.modelDir) {
		api.WriteError(w, -1, "Invalid model path")
		return
	}

	http.ServeFile(w, r, filePath)
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
	result, err := h.upgradeMgr.GetSystemUpdateVersion()
	if err != nil {
		api.WriteError(w, -1, "Failed to get update version")
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
