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
    this.showLoading('Checking device status...');
    
    try {
      // Check if supervisor is running
      const versionResult = await this.api.getVersion();
      if (!versionResult.success) {
        this.showError(`Cannot connect to supervisor at ${this.api.baseUrl}. Please ensure the supervisor service is running. You can check with: ps | grep supervisor`);
        
        // Show a retry button
        document.getElementById('loading-overlay').innerHTML = `
          <div style="background: white; padding: 2rem; border-radius: 0.5rem; text-align: center; max-width: 500px;">
            <h3 style="color: #ef4444; margin-bottom: 1rem;">Cannot Connect to Supervisor</h3>
            <p style="margin-bottom: 1rem;">The OOBE setup wizard needs the supervisor service to be running.</p>
            <p style="margin-bottom: 1rem; font-size: 0.875rem; color: #6b7280;">
              Trying to connect to: <strong>${this.api.baseUrl}</strong>
            </p>
            <div style="background: #f3f4f6; padding: 1rem; border-radius: 0.375rem; margin-bottom: 1rem; text-align: left;">
              <strong>Troubleshooting:</strong>
              <ul style="margin: 0.5rem 0 0 1.5rem; font-size: 0.875rem;">
                <li>Ensure supervisor is installed and running</li>
                <li>Check: <code>ps | grep supervisor</code></li>
                <li>Check: <code>netstat -tlnp | grep 443</code></li>
                <li>Start supervisor: <code>/etc/init.d/S93sscma-supervisor start</code></li>
              </ul>
            </div>
            <button class="btn btn-primary" onclick="location.reload()">Retry Connection</button>
          </div>
        `;
        return;
      }

      // Get device info
      const deviceResult = await this.api.queryDeviceInfo();
      if (deviceResult.success) {
        this.setupData.deviceInfo = deviceResult.data;
      }

      // Check if first login
      const userResult = await this.api.queryUserInfo();
      if (userResult.success) {
        this.setupData.userInfo = userResult.data;
      }

      this.hideLoading();
      this.showStep(1);
    } catch (error) {
      console.error('Initialization error:', error);
      this.showError('Failed to initialize setup. Please refresh the page.');
    }
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
    const serialNumber = this.setupData.deviceInfo?.sn || 'Unknown';
    document.getElementById('device-serial').textContent = serialNumber;
  }

  loadPasswordStep() {
    const isFirstLogin = this.setupData.userInfo?.firstLogin;
    const messageEl = document.getElementById('password-message');
    
    if (isFirstLogin) {
      messageEl.textContent = 'Please set a new password for your device. The default password must be changed for security.';
    } else {
      messageEl.textContent = 'Please enter your password to continue setup.';
    }
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
    if (!navigator.geolocation) {
      this.showError('Geolocation is not supported by your browser');
      return;
    }

    this.showLoading('Getting your location...');

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;
        
        // Try to reverse geocode using a free API
        try {
          const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`);
          if (response.ok) {
            const data = await response.json();
            const address = data.address;
            
            // Build location string
            let location = '';
            if (address.road) location += address.road;
            if (address.city) location += (location ? ', ' : '') + address.city;
            if (address.state) location += (location ? ', ' : '') + address.state;
            
            if (location) {
              document.getElementById('device-name').value = location;
              this.hideLoading();
            } else {
              this.hideLoading();
              this.showError('Could not determine address from location');
            }
          } else {
            this.hideLoading();
            // Fallback: just show coordinates
            document.getElementById('device-name').value = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
          }
        } catch (e) {
          this.hideLoading();
          // Fallback: just show coordinates
          document.getElementById('device-name').value = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
        }

        // Store coordinates for device info
        this.setupData.geolocation = {
          latitude: lat,
          longitude: lon,
          accuracy: position.coords.accuracy
        };
      },
      (error) => {
        this.hideLoading();
        this.showError('Could not get location: ' + error.message);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
  }

  async loadWiFiStep() {
    this.showLoading('Scanning for WiFi networks...');
    
    try {
      const result = await this.api.getWiFiInfoList();
      
      if (result.success && result.data.networks) {
        this.displayWiFiNetworks(result.data.networks);
      } else {
        this.showError('Failed to scan WiFi networks: ' + (result.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('WiFi scan error:', error);
      this.showError('Failed to scan WiFi networks');
    } finally {
      this.hideLoading();
    }
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
    if (this.setupData.userInfo?.firstLogin) {
      if (!newPassword || newPassword.length < 8) {
        this.showError('Password must be at least 8 characters long');
        return;
      }

      if (newPassword !== confirmPassword) {
        this.showError('Passwords do not match');
        return;
      }

      // Update password
      this.showLoading('Setting password...');
      const result = await this.api.updatePassword(oldPassword || 'admin', newPassword);
      
      if (!result.success) {
        this.hideLoading();
        this.showError('Failed to set password: ' + (result.error || 'Unknown error'));
        return;
      }

      // Login with new password (try both admin and recamera usernames)
      let loginResult = await this.api.login('admin', newPassword);
      if (!loginResult.success) {
        loginResult = await this.api.login('recamera', newPassword);
      }
      this.hideLoading();

      if (!loginResult.success) {
        this.showError('Password set but login failed. Please refresh and try again.');
        return;
      }
    } else {
      // Just login
      if (!oldPassword) {
        this.showError('Please enter your password');
        return;
      }

      this.showLoading('Logging in...');
      // Try both admin and recamera usernames
      let loginResult = await this.api.login('admin', oldPassword);
      if (!loginResult.success) {
        loginResult = await this.api.login('recamera', oldPassword);
      }
      this.hideLoading();

      if (!loginResult.success) {
        this.showError('Invalid password');
        return;
      }
    }

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
      const response = await fetch('/api/getNetworkInfo');
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
      const response = await fetch('/api/saveDeviceInfo', {
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
