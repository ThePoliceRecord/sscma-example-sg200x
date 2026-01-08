package handler

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"supervisor/internal/api"
	"supervisor/pkg/logger"
)

// UpdateConfigHandler handles update configuration API requests.
type UpdateConfigHandler struct {
	configPath string
}

// UpdateConfig represents the update configuration.
type UpdateConfig struct {
	OSSource           string `json:"os_source"`            // "tpr_official" or "self_hosted"
	ModelSource        string `json:"model_source"`         // "tpr_official" or "self_hosted"
	SelfHostedOSUrl    string `json:"self_hosted_os_url"`
	SelfHostedModelUrl string `json:"self_hosted_model_url"`
	CheckFrequency     string `json:"check_frequency"` // "30min", "daily", "weekly", "manual"
	WeeklyDay          string `json:"weekly_day"`      // "sunday", "monday", etc.
}

// NewUpdateConfigHandler creates a new UpdateConfigHandler.
func NewUpdateConfigHandler() *UpdateConfigHandler {
	return &UpdateConfigHandler{
		configPath: "/etc/supervisor/update.conf",
	}
}

// GetConfig returns the current update configuration.
func (h *UpdateConfigHandler) GetConfig(w http.ResponseWriter, r *http.Request) {
	config, err := h.loadConfig()
	if err != nil {
		// Return default config if file doesn't exist
		config = h.getDefaultConfig()
	}

	api.WriteSuccess(w, config)
}

// SetConfig updates the update configuration.
func (h *UpdateConfigHandler) SetConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		api.WriteError(w, -1, "Method not allowed")
		return
	}

	var config UpdateConfig
	if err := api.ParseJSONBody(r, &config); err != nil {
		api.WriteError(w, -1, "Invalid request body")
		return
	}

	// Validate configuration
	if err := h.validateConfig(&config); err != nil {
		api.WriteError(w, -1, err.Error())
		return
	}

	// Save configuration
	if err := h.saveConfig(&config); err != nil {
		logger.Error("Failed to save update config: %v", err)
		api.WriteError(w, -1, "Failed to save configuration")
		return
	}

	api.WriteSuccess(w, map[string]interface{}{
		"status":  "success",
		"message": "Update configuration saved",
	})
}

// loadConfig loads the update configuration from file.
func (h *UpdateConfigHandler) loadConfig() (*UpdateConfig, error) {
	data, err := os.ReadFile(h.configPath)
	if err != nil {
		return nil, err
	}

	var config UpdateConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}

	return &config, nil
}

// saveConfig saves the update configuration to file.
func (h *UpdateConfigHandler) saveConfig(config *UpdateConfig) error {
	// Ensure directory exists
	dir := filepath.Dir(h.configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(h.configPath, data, 0644)
}

// validateConfig validates the update configuration.
func (h *UpdateConfigHandler) validateConfig(config *UpdateConfig) error {
	// Validate OS source
	if config.OSSource != "tpr_official" && config.OSSource != "self_hosted" {
		return api.NewError("Invalid OS source. Must be 'tpr_official' or 'self_hosted'")
	}

	// Validate model source
	if config.ModelSource != "tpr_official" && config.ModelSource != "self_hosted" {
		return api.NewError("Invalid model source. Must be 'tpr_official' or 'self_hosted'")
	}

	// Validate self-hosted URLs if specified
	if config.OSSource == "self_hosted" && config.SelfHostedOSUrl != "" {
		if !isValidUpdateURL(config.SelfHostedOSUrl) {
			return api.NewError("Invalid OS update URL. Must be a valid http/https URL")
		}
	}
	if config.ModelSource == "self_hosted" && config.SelfHostedModelUrl != "" {
		if !isValidUpdateURL(config.SelfHostedModelUrl) {
			return api.NewError("Invalid model update URL. Must be a valid http/https URL")
		}
	}

	// Validate check frequency
	validFrequencies := map[string]bool{
		"30min":  true,
		"daily":  true,
		"weekly": true,
		"manual": true,
	}
	if !validFrequencies[config.CheckFrequency] {
		return api.NewError("Invalid check frequency. Must be '30min', 'daily', 'weekly', or 'manual'")
	}

	// Validate weekly day if frequency is weekly
	if config.CheckFrequency == "weekly" {
		validDays := map[string]bool{
			"sunday":    true,
			"monday":    true,
			"tuesday":   true,
			"wednesday": true,
			"thursday":  true,
			"friday":    true,
			"saturday":  true,
		}
		if !validDays[config.WeeklyDay] {
			return api.NewError("Invalid weekly day")
		}
	}

	return nil
}

// isValidUpdateURL validates update server URLs to prevent SSRF attacks.
func isValidUpdateURL(urlStr string) bool {
	if urlStr == "" {
		return false
	}
	
	// Limit URL length
	if len(urlStr) > 2048 {
		return false
	}

	// Parse URL
	u, err := url.Parse(urlStr)
	if err != nil {
		return false
	}

	// Only allow http and https schemes
	if u.Scheme != "http" && u.Scheme != "https" {
		return false
	}

	// Prevent localhost and internal IP addresses to mitigate SSRF
	host := strings.ToLower(u.Hostname())
	
	// Block localhost
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return false
	}
	
	// Block private IP ranges (RFC 1918)
	if strings.HasPrefix(host, "192.168.") ||
		strings.HasPrefix(host, "10.") ||
		strings.HasPrefix(host, "172.16.") ||
		strings.HasPrefix(host, "172.17.") ||
		strings.HasPrefix(host, "172.18.") ||
		strings.HasPrefix(host, "172.19.") ||
		strings.HasPrefix(host, "172.20.") ||
		strings.HasPrefix(host, "172.21.") ||
		strings.HasPrefix(host, "172.22.") ||
		strings.HasPrefix(host, "172.23.") ||
		strings.HasPrefix(host, "172.24.") ||
		strings.HasPrefix(host, "172.25.") ||
		strings.HasPrefix(host, "172.26.") ||
		strings.HasPrefix(host, "172.27.") ||
		strings.HasPrefix(host, "172.28.") ||
		strings.HasPrefix(host, "172.29.") ||
		strings.HasPrefix(host, "172.30.") ||
		strings.HasPrefix(host, "172.31.") {
		return false
	}
	
	// Block link-local addresses
	if strings.HasPrefix(host, "169.254.") {
		return false
	}

	return true
}

// getDefaultConfig returns the default update configuration.
func (h *UpdateConfigHandler) getDefaultConfig() *UpdateConfig {
	return &UpdateConfig{
		OSSource:           "tpr_official",
		ModelSource:        "tpr_official",
		SelfHostedOSUrl:    "",
		SelfHostedModelUrl: "",
		CheckFrequency:     "daily",
		WeeklyDay:          "sunday",
	}
}
