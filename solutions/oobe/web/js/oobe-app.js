/**
 * Authority Alert OOBE Application
 * Handles the out-of-box experience setup flow
 */

class OOBEApp {
  constructor() {
    this.api = new SupervisorAPI(); // Auto-detect supervisor URL
    this.currentStep = 1;
    this.setupData = {
      deviceInfo: null,
      userInfo: null,
      deviceName: '',
      timezone: '',
      wifiSSID: '',
      wifiPassword: '',
      wifiSecurity: 'WPA2'
    };
    
    this.init();
  }

  async init() {
    console.log('Initializing OOBE...');
    this.hideLoading();
    
    // Start at step 1 (Welcome)
    // We'll login when the user provides the old password in step 2
    this.showStep(1);
  }

  showStep(step) {
    this.currentStep = step;
    
    // Hide all steps
    document.querySelectorAll('.setup-step').forEach(el => {
      el.classList.add('hidden');
    });

    // Show current step
    const stepElement = document.getElementById(`step-${step}`);
    if (stepElement) {
      stepElement.classList.remove('hidden');
    }

    // Update step indicators
    document.querySelectorAll('.step').forEach((el, index) => {
      el.classList.remove('active', 'completed');
      if (index + 1 < step) {
        el.classList.add('completed');
      } else if (index + 1 === step) {
        el.classList.add('active');
      }
    });

    // Load step content
    switch (step) {
      case 1:
        this.loadWelcomeStep();
        break;
      case 2:
        this.loadPasswordStep();
        break;
      case 3:
        this.loadDeviceConfigStep();
        break;
      case 4:
        this.loadWiFiStep();
        break;
      case 5:
        this.loadCompletionStep();
        break;
    }
  }

  loadWelcomeStep() {
    // Welcome step - no additional setup needed
  }

  loadPasswordStep() {
    const messageEl = document.getElementById('password-message');
    messageEl.textContent = 'Please enter the current password and set a new password for your device.';
  }

  async loadDeviceConfigStep() {
    // Load timezone list
    const timezoneResult = await this.api.getTimezoneList();
    if (timezoneResult.success && timezoneResult.data.timezones) {
      const select = document.getElementById('timezone-select');
      select.innerHTML = '<option value="">Select timezone...</option>';
      
      timezoneResult.data.timezones.forEach(tz => {
        const option = document.createElement('option');
        option.value = tz;
        option.textContent = tz;
        select.appendChild(option);
      });

      // Try to detect user's timezone
      try {
        const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (userTimezone) {
          select.value = userTimezone;
          this.setupData.timezone = userTimezone;
        }
      } catch (e) {
        console.log('Could not detect timezone');
      }
    }

    // Set current date and time from browser
    const now = new Date();
    const dateInput = document.getElementById('device-date');
    const timeInput = document.getElementById('device-time');
    
    if (dateInput) {
      // Format: YYYY-MM-DD
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      dateInput.value = `${year}-${month}-${day}`;
    }
    
    if (timeInput) {
      // Format: HH:MM
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      timeInput.value = `${hours}:${minutes}`;
    }
  }

  async requestGeolocation() {
    // Check if geolocation is available
    if (!navigator.geolocation) {
      this.showError('Geolocation is not supported by your browser. Please enter the location manually.');
      return;
    }

    // Check if we're in a secure context (required for geolocation)
    // Note: localhost and 127.0.0.1 are considered secure, but other IPs with self-signed certs may not be
    if (typeof window.isSecureContext !== 'undefined' && !window.isSecureContext) {
      this.showError('Geolocation requires a secure connection. Please enter the location manually.');
      return;
    }

    this.showLoading('Getting your location...');

    // Helper to get human-readable error message
    const getGeolocationErrorMessage = (error) => {
      // Handle the case where error might not have standard properties
      if (!error) {
        return 'Unable to get location. Please enter it manually.';
      }

      // Standard GeolocationPositionError codes
      const PERMISSION_DENIED = 1;
      const POSITION_UNAVAILABLE = 2;
      const TIMEOUT = 3;

      switch (error.code) {
        case PERMISSION_DENIED:
          return 'Location permission denied. Please allow location access in your browser settings and try again.';
        case POSITION_UNAVAILABLE:
          return 'Location information unavailable. Your device may not have location services, or they may be disabled.';
        case TIMEOUT:
          return 'Location request timed out. Please try again or enter the location manually.';
        default:
          // Include the error message if available for debugging
          const msg = error.message || 'Unknown error';
          console.log('Geolocation error:', error);
          return `Unable to get location (${msg}). Please enter it manually.`;
      }
    };

    // Try to get position with promise wrapper
    const tryGetPosition = (highAccuracy, timeoutMs) => {
      return new Promise((resolve, reject) => {
        const options = {
          enableHighAccuracy: highAccuracy,
          timeout: timeoutMs,
          maximumAge: 300000 // Accept cached position up to 5 minutes old
        };

        navigator.geolocation.getCurrentPosition(resolve, reject, options);
      });
    };

    try {
      let position = null;
      let lastError = null;

      // Strategy 1: Try with low accuracy first (faster, works with WiFi/IP)
      try {
        console.log('Trying low accuracy geolocation...');
        position = await tryGetPosition(false, 20000);
      } catch (lowAccuracyError) {
        console.log('Low accuracy failed:', lowAccuracyError.code, lowAccuracyError.message);
        lastError = lowAccuracyError;
      }

      // Strategy 2: If low accuracy failed with timeout, try high accuracy
      if (!position && lastError && lastError.code === 3) { // TIMEOUT
        try {
          console.log('Trying high accuracy geolocation...');
          position = await tryGetPosition(true, 30000);
        } catch (highAccuracyError) {
          console.log('High accuracy failed:', highAccuracyError.code, highAccuracyError.message);
          lastError = highAccuracyError;
        }
      }

      // If we still don't have a position, throw the last error
      if (!position) {
        throw lastError || new Error('Unable to get location');
      }

      const lat = position.coords.latitude;
      const lon = position.coords.longitude;

      console.log(`Got location: ${lat}, ${lon} (accuracy: ${position.coords.accuracy}m)`);

      // Store coordinates for device info
      this.setupData.geolocation = {
        latitude: lat,
        longitude: lon,
        accuracy: position.coords.accuracy
      };

      // Try to reverse geocode using OpenStreetMap Nominatim API
      let locationSet = false;
      try {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
          {
            headers: {
              'Accept': 'application/json'
            }
          }
        );
        if (response.ok) {
          const data = await response.json();
          const address = data.address || {};

          // Build location string from address components
          let location = '';
          // Try different address fields in order of preference
          const road = address.road || address.street || address.pedestrian || address.footway || '';
          const houseNumber = address.house_number || '';
          const city = address.city || address.town || address.village || address.hamlet || address.municipality || '';
          const state = address.state || address.region || address.county || '';

          if (houseNumber && road) {
            location = `${houseNumber} ${road}`;
          } else if (road) {
            location = road;
          }
          if (city) location += (location ? ', ' : '') + city;
          if (state) location += (location ? ', ' : '') + state;

          if (location) {
            document.getElementById('device-name').value = location;
            locationSet = true;
          }
        }
      } catch (geocodeError) {
        console.log('Geocoding failed:', geocodeError);
      }

      // Fallback to coordinates if geocoding didn't work
      if (!locationSet) {
        document.getElementById('device-name').value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
      }

      this.hideLoading();
    } catch (error) {
      this.hideLoading();
      this.showError(getGeolocationErrorMessage(error));
    }
  }

  async loadWiFiStep() {
    await this.scanWiFiNetworks();
  }

  async scanWiFiNetworks(retryCount = 0) {
    const maxRetries = 3;
    const retryDelay = 2000; // 2 seconds between retries
    
    this.showLoading('Scanning for WiFi networks...');
    
    try {
      // Check if we have a valid token before attempting WiFi scan
      const token = localStorage.getItem('authToken');
      if (!token) {
        this.hideLoading();
        this.showError('Authentication required. Please go back and login again.');
        console.error('No auth token found in localStorage');
        return;
      }
      
      console.log(`Scanning WiFi (attempt ${retryCount + 1}/${maxRetries + 1}) with token:`, token.substring(0, 20) + '...');
      const result = await this.api.getWiFiInfoList();
      
      if (result.success && result.data) {
        // The API returns wifiInfoList, not networks
        const networks = result.data.wifiInfoList || [];
        console.log('Found', networks.length, 'WiFi networks');
        
        // If no networks found and we haven't exhausted retries, wait and try again
        if (networks.length === 0 && retryCount < maxRetries) {
          console.log(`No networks found, retrying in ${retryDelay}ms...`);
          this.showLoading(`Scanning for WiFi networks... (attempt ${retryCount + 2}/${maxRetries + 1})`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          return this.scanWiFiNetworks(retryCount + 1);
        }
        
        if (networks.length === 0) {
          // Show message but don't error - user can rescan
          this.displayWiFiNetworks([]);
          this.hideLoading();
          this.showError('No WiFi networks found after multiple scans. Click "Rescan Networks" to try again, or check your WiFi adapter.');
          return;
        }
        
        // Transform the data to match our expected format
        const transformedNetworks = networks.map(network => ({
          ssid: network.ssid,
          signal: network.signal,
          security: network.auth === 0 ? 'Open' : 'WPA2',
          connected: network.connectedStatus === 1,
          bssid: network.bssid,
          frequency: network.frequency
        }));
        
        this.displayWiFiNetworks(transformedNetworks);
      } else {
        // Check if it's an auth error
        if (result.code === 401 || result.error?.includes('401')) {
          this.showError('Authentication failed. Please go back and login again.');
          console.error('WiFi scan auth error:', result);
        } else {
          this.showError('Failed to scan WiFi networks: ' + (result.error || 'Unknown error'));
        }
      }
    } catch (error) {
      console.error('WiFi scan error:', error);
      this.showError('Failed to scan WiFi networks: ' + error.message);
    } finally {
      this.hideLoading();
    }
  }

  async rescanWiFi() {
    console.log('User requested WiFi rescan');
    await this.scanWiFiNetworks();
  }

  displayWiFiNetworks(networks) {
    const listEl = document.getElementById('wifi-list');
    listEl.innerHTML = '';

    if (networks.length === 0) {
      listEl.innerHTML = '<div class="alert alert-info">No WiFi networks found. Please check your WiFi adapter.</div>';
      return;
    }

    networks.forEach(network => {
      const item = document.createElement('div');
      item.className = 'wifi-item';
      item.onclick = () => this.selectWiFiNetwork(network.ssid, network.security);

      const signalStrength = this.getSignalStrength(network.signal);
      
      item.innerHTML = `
        <div class="wifi-info">
          <div class="wifi-ssid">${this.escapeHtml(network.ssid)}</div>
          <div class="wifi-details">
            ${network.security} • Signal: ${signalStrength}
            ${network.connected ? ' • <strong>Connected</strong>' : ''}
          </div>
        </div>
        <div class="wifi-signal">${this.getSignalIcon(network.signal)}</div>
      `;

      listEl.appendChild(item);
    });
  }

  selectWiFiNetwork(ssid, security) {
    this.setupData.wifiSSID = ssid;
    this.setupData.wifiSecurity = security;

    // Update UI
    document.querySelectorAll('.wifi-item').forEach(el => {
      el.classList.remove('selected');
    });
    event.currentTarget.classList.add('selected');

    // Show password input if secured
    const passwordGroup = document.getElementById('wifi-password-group');
    if (security !== 'Open') {
      passwordGroup.classList.remove('hidden');
      document.getElementById('wifi-password').focus();
    } else {
      passwordGroup.classList.add('hidden');
      this.setupData.wifiPassword = '';
    }
  }

  getSignalStrength(signal) {
    if (signal >= -50) return 'Excellent';
    if (signal >= -60) return 'Good';
    if (signal >= -70) return 'Fair';
    return 'Weak';
  }

  getSignalIcon(signal) {
    if (signal >= -50) return '📶';
    if (signal >= -60) return '📶';
    if (signal >= -70) return '📶';
    return '📶';
  }

  loadCompletionStep() {
    const summaryEl = document.getElementById('setup-summary');
    summaryEl.innerHTML = `
      <div class="device-info">
        <div class="device-info-item">
          <span class="device-info-label">Device Name:</span>
          <span class="device-info-value">${this.escapeHtml(this.setupData.deviceName)}</span>
        </div>
        <div class="device-info-item">
          <span class="device-info-label">Timezone:</span>
          <span class="device-info-value">${this.escapeHtml(this.setupData.timezone)}</span>
        </div>
        <div class="device-info-item">
          <span class="device-info-label">WiFi Network:</span>
          <span class="device-info-value">${this.escapeHtml(this.setupData.wifiSSID)}</span>
        </div>
      </div>
    `;
  }

  // Step Actions

  async handleWelcomeNext() {
    this.showStep(2);
  }

  async handlePasswordNext() {
    const oldPassword = document.getElementById('old-password').value;
    const newPassword = document.getElementById('new-password').value;
    const confirmPassword = document.getElementById('confirm-password').value;

    // Validation
    if (!oldPassword) {
      this.showError('Please enter the current password');
      return;
    }

    if (!newPassword || newPassword.length < 8) {
      this.showError('New password must be at least 8 characters long');
      return;
    }

    if (newPassword !== confirmPassword) {
      this.showError('Passwords do not match');
      return;
    }

    this.showLoading('Logging in...');
    
    // First, login with the old password to get a token
    let loginResult = await this.api.login('recamera', oldPassword);
    if (!loginResult.success) {
      loginResult = await this.api.login('admin', oldPassword);
    }

    if (!loginResult.success) {
      this.hideLoading();
      this.showError('Invalid current password');
      return;
    }

    // Now we have a token, use it to change the password
    this.showLoading('Setting new password...');
    const result = await this.api.updatePassword(oldPassword, newPassword);
    
    console.log('Password update result:', result);
    
    if (!result.success) {
      this.hideLoading();
      const errorMsg = result.error || result.msg || 'Unknown error';
      this.showError('Failed to set password: ' + errorMsg);
      console.error('Password update failed:', result);
      return;
    }

    // Login with new password to get a fresh token
    this.showLoading('Verifying new password...');
    loginResult = await this.api.login('recamera', newPassword);
    if (!loginResult.success) {
      loginResult = await this.api.login('admin', newPassword);
    }

    if (!loginResult.success) {
      this.hideLoading();
      this.showError('Password set but login failed. Please refresh and try again.');
      console.error('Login with new password failed:', loginResult);
      return;
    }
    
    console.log('Successfully logged in with new password');

    // Fetch device and user info now that we're logged in
    const deviceResult = await this.api.queryDeviceInfo();
    if (deviceResult.success) {
      this.setupData.deviceInfo = deviceResult.data;
    }

    const userResult = await this.api.queryUserInfo();
    if (userResult.success) {
      this.setupData.userInfo = userResult.data;
    }

    this.hideLoading();
    this.showStep(3);
  }

  async handleDeviceConfigNext() {
    const deviceName = document.getElementById('device-name').value.trim();
    const timezone = document.getElementById('timezone-select').value;
    const dateValue = document.getElementById('device-date').value;
    const timeValue = document.getElementById('device-time').value;

    if (!deviceName) {
      this.showError('Please enter a location');
      return;
    }

    if (!timezone) {
      this.showError('Please select a timezone');
      return;
    }

    if (!dateValue || !timeValue) {
      this.showError('Please set the date and time');
      return;
    }

    this.setupData.deviceName = deviceName;
    this.setupData.timezone = timezone;

    this.showLoading('Saving device configuration...');

    // Update device name
    const nameResult = await this.api.updateDeviceName(deviceName);
    if (!nameResult.success) {
      this.hideLoading();
      this.showError('Failed to set device name: ' + (nameResult.error || 'Unknown error'));
      return;
    }

    // Update timezone
    const tzResult = await this.api.setTimezone(timezone);
    if (!tzResult.success) {
      this.hideLoading();
      this.showError('Failed to set timezone: ' + (tzResult.error || 'Unknown error'));
      return;
    }

    // Set system time from user input
    const dateTimeString = `${dateValue}T${timeValue}:00`;
    const timestamp = Math.floor(new Date(dateTimeString).getTime() / 1000);
    const timeResult = await this.api.setTimestamp(timestamp);
    if (!timeResult.success) {
      console.warn('Failed to set timestamp:', timeResult.error);
      // Don't fail the setup if time sync fails
    }

    this.hideLoading();
    this.showStep(4);
  }

  async handleWiFiNext() {
    if (!this.setupData.wifiSSID) {
      this.showError('Please select a WiFi network');
      return;
    }

    const password = document.getElementById('wifi-password').value;
    
    if (this.setupData.wifiSecurity !== 'Open' && !password) {
      this.showError('Please enter the WiFi password');
      return;
    }

    this.setupData.wifiPassword = password;

    this.showLoading('Connecting to WiFi...');

    const result = await this.api.connectWiFi(
      this.setupData.wifiSSID,
      this.setupData.wifiPassword,
      this.setupData.wifiSecurity
    );

    this.hideLoading();

    if (!result.success) {
      this.showError('Failed to connect to WiFi: ' + (result.error || 'Unknown error'));
      return;
    }

    this.showStep(5);
  }

  async handleWiFiSkip() {
    if (confirm('Are you sure you want to skip WiFi setup? You can configure it later.')) {
      this.setupData.wifiSSID = 'Skipped';
      this.showStep(5);
    }
  }

  async handleComplete() {
    this.showLoading('Finalizing setup...');

    // Collect and save device information
    try {
      await this.saveDeviceInfo();
    } catch (e) {
      console.error('Failed to save device info:', e);
    }

    // Optional: Set LED to indicate completion
    try {
      await this.api.setLED('led0', 255, 'heartbeat');
    } catch (e) {
      console.log('Could not set LED');
    }

    this.hideLoading();

    // Show success message
    document.getElementById('completion-message').innerHTML = `
      <div class="alert alert-success">
        <strong>Setup Complete!</strong><br>
        Your Authority Alert device is ready to use.
      </div>
    `;

    // Redirect to activation page after a delay
    setTimeout(() => {
      window.location.href = 'https://dev.thepolicerecord.com/activate/camera/';
    }, 2000);
  }

  async saveDeviceInfo() {
    // Get detailed device info from supervisor (uses QueryDeviceInfo)
    const deviceResult = await this.api.queryDeviceInfo();
    const deviceData = deviceResult.data || {};
    
    // Get network MAC addresses from OOBE server
    let networkInfo = { interfaces: {} };
    try {
      const response = await fetch('/oobe/api/getNetworkInfo');
      if (response.ok) {
        networkInfo = await response.json();
      }
    } catch (e) {
      console.log('Could not get network info');
    }

    // Collect browser information
    const browserInfo = {
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform,
      screenResolution: `${screen.width}x${screen.height}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    };

    // Collect all device information using correct API field names
    const deviceInfo = {
      serialNumber: deviceData.sn || 'Unknown',
      cpu: deviceData.cpu || 'SG2002',
      ram: deviceData.ram || '256MB',
      npu: deviceData.npu || '1 TOPS',
      os: deviceData.osName || 'reCamera OS',
      osVersion: deviceData.osVersion || 'Unknown',
      deviceType: deviceData.type || 'Basic WiFi 64G (OV5647)',
      location: this.setupData.deviceName,  // Device name is the location
      timezone: this.setupData.timezone,
      setupDate: new Date().toISOString(),
      networkInterfaces: {
        eth0: deviceData.macAddress || networkInfo.interfaces?.eth0?.mac || 'Unknown',
        wlan0: networkInfo.interfaces?.wlan0?.mac || 'Unknown'
      },
      geolocation: this.setupData.geolocation || null,
      browserInfo: browserInfo
    };

    // Save to OOBE server which will write to /userdata/device_info.json
    try {
      const response = await fetch('/oobe/api/saveDeviceInfo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(deviceInfo, null, 2)
      });

      const result = await response.json();
      if (result.ok) {
        console.log('Device info saved successfully to /userdata/device_info.json');
      } else {
        console.error('Failed to save device info:', result.error);
      }
    } catch (e) {
      console.error('Error saving device info:', e);
    }

    // Signal OOBE completion - removes /etc/oobe/flag
    try {
      await fetch('/oobe/api/complete', { method: 'POST' });
      console.log('OOBE flag removed');
    } catch (e) {
      console.error('Error completing OOBE:', e);
    }
  }

  // UI Helpers

  showLoading(message = 'Loading...') {
    const loadingEl = document.getElementById('loading-overlay');
    const messageEl = document.getElementById('loading-message');
    
    if (loadingEl && messageEl) {
      messageEl.textContent = message;
      loadingEl.classList.remove('hidden');
    }
  }

  hideLoading() {
    const loadingEl = document.getElementById('loading-overlay');
    if (loadingEl) {
      loadingEl.classList.add('hidden');
    }
  }

  showError(message) {
    const alertEl = document.getElementById('error-alert');
    const messageEl = document.getElementById('error-message');
    
    if (alertEl && messageEl) {
      messageEl.textContent = message;
      alertEl.classList.remove('hidden');
      
      // Auto-hide after 5 seconds
      setTimeout(() => {
        alertEl.classList.add('hidden');
      }, 5000);
    } else {
      alert(message);
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.oobeApp = new OOBEApp();
});
