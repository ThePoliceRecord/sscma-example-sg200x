/**
 * Supervisor API Client
 * Provides a clean interface to interact with the supervisor's REST APIs
 */

class SupervisorAPI {
  constructor(baseUrl = null) {
    // Auto-detect supervisor URL
    // Try current hostname first, then localhost
    if (!baseUrl) {
      const hostname = window.location.hostname;
      // If accessing via IP or hostname, use that for supervisor
      if (hostname && hostname !== 'localhost' && hostname !== '127.0.0.1') {
        this.baseUrl = `https://${hostname}`;
      } else {
        this.baseUrl = 'https://localhost';
      }
    } else {
      this.baseUrl = baseUrl;
    }
    this.token = localStorage.getItem('authToken');
  }

  /**
   * Make an API request to the supervisor
   */
  async request(endpoint, method = 'GET', body = null, requiresAuth = true) {
    const options = {
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    // Add auth token if required and available
    if (requiresAuth && this.token) {
      options.headers['Authorization'] = `Bearer ${this.token}`;
    }

    // Add body for POST requests
    if (body) {
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, options);
      const data = await response.json();

      if (data.code === 0) {
        return { success: true, data: data.data };
      } else {
        return { success: false, error: data.msg, code: data.code };
      }
    } catch (error) {
      console.error('API request failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Save authentication token
   */
  setToken(token) {
    this.token = token;
    localStorage.setItem('authToken', token);
  }

  /**
   * Clear authentication token
   */
  clearToken() {
    this.token = null;
    localStorage.removeItem('authToken');
  }

  // ========== System Information ==========

  async getVersion() {
    return this.request('/api/version', 'GET', null, false);
  }

  // ========== User Management ==========

  async queryUserInfo() {
    return this.request('/api/userMgr/queryUserInfo', 'GET', null, false);
  }

  async login(username, password) {
    const result = await this.request('/api/userMgr/login', 'POST', {
      username,
      password
    }, false);

    if (result.success && result.data.token) {
      this.setToken(result.data.token);
    }

    return result;
  }

  async updatePassword(oldPassword, newPassword) {
    return this.request('/api/userMgr/updatePassword', 'POST', {
      oldPassword,
      newPassword
    }, false);
  }

  async setSSHStatus(enabled) {
    return this.request('/api/userMgr/setSShStatus', 'POST', {
      enabled
    });
  }

  // ========== Device Management ==========

  async queryDeviceInfo() {
    return this.request('/api/deviceMgr/queryDeviceInfo', 'GET', null, false);
  }

  async getDeviceInfo() {
    return this.request('/api/deviceMgr/getDeviceInfo');
  }

  async updateDeviceName(deviceName) {
    return this.request('/api/deviceMgr/updateDeviceName', 'POST', {
      deviceName
    });
  }

  async getSystemStatus() {
    return this.request('/api/deviceMgr/getSystemStatus');
  }

  async queryServiceStatus() {
    return this.request('/api/deviceMgr/queryServiceStatus', 'GET', null, false);
  }

  async setPower(action) {
    return this.request('/api/deviceMgr/setPower', 'POST', {
      action
    });
  }

  // ========== Time Configuration ==========

  async getTimestamp() {
    return this.request('/api/deviceMgr/getTimestamp');
  }

  async setTimestamp(timestamp) {
    return this.request('/api/deviceMgr/setTimestamp', 'POST', {
      timestamp
    });
  }

  async getTimezone() {
    return this.request('/api/deviceMgr/getTimezone');
  }

  async setTimezone(timezone) {
    return this.request('/api/deviceMgr/setTimezone', 'POST', {
      timezone
    });
  }

  async getTimezoneList() {
    return this.request('/api/deviceMgr/getTimezoneList');
  }

  // ========== WiFi Management ==========

  async getWiFiInfoList() {
    return this.request('/api/wifiMgr/getWiFiInfoList');
  }

  async connectWiFi(ssid, password, security = 'WPA2') {
    return this.request('/api/wifiMgr/connectWiFi', 'POST', {
      ssid,
      password,
      security
    });
  }

  async disconnectWiFi() {
    return this.request('/api/wifiMgr/disconnectWiFi', 'POST');
  }

  async forgetWiFi(ssid) {
    return this.request('/api/wifiMgr/forgetWiFi', 'POST', {
      ssid
    });
  }

  // ========== Platform Configuration ==========

  async getPlatformInfo() {
    return this.request('/api/deviceMgr/getPlatformInfo');
  }

  async savePlatformInfo(platformUrl, apiKey, deviceId) {
    return this.request('/api/deviceMgr/savePlatformInfo', 'POST', {
      platformUrl,
      apiKey,
      deviceId
    });
  }

  // ========== Camera ==========

  async getChannels() {
    return this.request('/api/channels', 'GET', null, false);
  }

  async getCameraWebsocketUrl() {
    return this.request('/api/deviceMgr/getCameraWebsocketUrl');
  }

  // ========== LED Management ==========

  async getLEDs() {
    return this.request('/api/ledMgr/getLEDs');
  }

  async setLED(name, brightness, trigger = 'none') {
    return this.request('/api/ledMgr/setLED', 'POST', {
      name,
      brightness,
      trigger
    });
  }

  // ========== QR Code Scanner ==========

  /**
   * Start a QR code scan session
   * @param {number} timeout - Scan timeout in seconds (default: 30)
   * @param {number} maxResults - Maximum QR codes to detect (default: 1, 0=unlimited)
   * @param {string} schema - Optional schema validation (authority_config, wifi_config, device_pairing)
   * @returns {Promise} {success: boolean, data: {scan_id: string, status: string, started_at: string}}
   */
  async startQRScan(timeout = 30, maxResults = 1, schema = null) {
    const body = { timeout, max_results: maxResults };
    if (schema) {
      body.schema = schema;
    }
    return this.request('/api/qr/scan', 'POST', body, false);
  }

  /**
   * Get status of a QR scan session
   * @param {string} scanId - Scan session ID
   * @returns {Promise} {success: boolean, data: {scan_id: string, status: string, result?: object}}
   */
  async getQRScanStatus(scanId) {
    return this.request(`/api/qr/scan/${scanId}`, 'GET', null, false);
  }

  /**
   * Cancel an active QR scan session
   * @param {string} scanId - Scan session ID
   * @returns {Promise} {success: boolean, data: {scan_id: string, status: string}}
   */
  async cancelQRScan(scanId) {
    return this.request(`/api/qr/scan/${scanId}`, 'DELETE', null, false);
  }

  /**
   * Helper method to scan and wait for result (polls automatically)
   * @param {number} timeout - Scan timeout in seconds
   * @param {number} maxResults - Maximum QR codes to detect
   * @param {string} schema - Optional schema validation
   * @param {function} onProgress - Optional callback for progress updates
   * @returns {Promise} Result object with QR code data
   */
  async scanQRCode(timeout = 30, maxResults = 1, schema = null, onProgress = null) {
    // Start scan
    const startResult = await this.startQRScan(timeout, maxResults, schema);
    if (!startResult.success) {
      throw new Error(startResult.error || 'Failed to start QR scan');
    }

    const scanId = startResult.data.scan_id;
    const pollInterval = 500; // Poll every 500ms

    // Poll for results
    return new Promise((resolve, reject) => {
      const intervalId = setInterval(async () => {
        try {
          const statusResult = await this.getQRScanStatus(scanId);
          
          if (!statusResult.success) {
            clearInterval(intervalId);
            reject(new Error(statusResult.error || 'Failed to get scan status'));
            return;
          }

          const { status, result } = statusResult.data;

          // Call progress callback if provided
          if (onProgress) {
            onProgress(status, result);
          }

          // Check if scan is complete
          if (status === 'complete') {
            clearInterval(intervalId);
            resolve(result);
          } else if (status === 'timeout') {
            clearInterval(intervalId);
            reject(new Error('QR scan timed out - no QR code detected'));
          } else if (status === 'cancelled') {
            clearInterval(intervalId);
            reject(new Error('QR scan was cancelled'));
          } else if (status === 'error') {
            clearInterval(intervalId);
            reject(new Error(result?.reason || 'QR scan failed'));
          }
          // Otherwise status === 'scanning', keep polling
        } catch (error) {
          clearInterval(intervalId);
          reject(error);
        }
      }, pollInterval);

      // Cleanup on timeout (scan timeout + 5 seconds grace period)
      setTimeout(() => {
        clearInterval(intervalId);
        this.cancelQRScan(scanId).catch(() => {}); // Best effort cancel
        reject(new Error('QR scan polling timeout'));
      }, (timeout + 5) * 1000);
    });
  }
}

// Export for use in other scripts
window.SupervisorAPI = SupervisorAPI;
