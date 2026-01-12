/**
 * Authority Alert OOBE Application
 * Handles the out-of-box experience setup flow
 */

/**
 * Secure Token Manager
 * Stores tokens in memory with sessionStorage fallback
 * Provides better XSS protection than localStorage
 */
class SecureTokenManager {
  constructor() {
    // Store tokens in memory (cleared on page reload)
    this.tokens = new Map();
    
    // Use sessionStorage as fallback (cleared when tab closes)
    // This is more secure than localStorage which persists indefinitely
    this.storage = window.sessionStorage;
    
    // Token expiration tracking
    this.expirations = new Map();
    
    // Migrate any existing localStorage tokens to secure storage
    this.migrateFromLocalStorage();
  }
  
  /**
   * Migrate tokens from localStorage to secure storage
   */
  migrateFromLocalStorage() {
    const tokensToMigrate = [
      'authToken',
      'platformAccessToken',
      'platformRefreshToken',
      'platformIdToken'
    ];
    
    tokensToMigrate.forEach(key => {
      const value = localStorage.getItem(key);
      if (value) {
        console.log(`Migrating ${key} from localStorage to secure storage`);
        this.setToken(key, value);
        localStorage.removeItem(key);
      }
    });
  }
  
  /**
   * Set a token with optional expiration
   */
  setToken(key, value, expiresInSeconds = null) {
    if (!key || !value) return;
    
    // Store in memory
    this.tokens.set(key, value);
    
    // Store in sessionStorage as backup
    try {
      this.storage.setItem(key, value);
    } catch (e) {
      console.warn('Failed to store token in sessionStorage:', e);
    }
    
    // Set expiration if provided
    if (expiresInSeconds) {
      const expiresAt = Date.now() + (expiresInSeconds * 1000);
      this.expirations.set(key, expiresAt);
    }
  }
  
  /**
   * Get a token, checking expiration
   */
  getToken(key) {
    // Check if token is expired
    if (this.expirations.has(key)) {
      const expiresAt = this.expirations.get(key);
      if (Date.now() > expiresAt) {
        console.log(`Token ${key} has expired`);
        this.removeToken(key);
        return null;
      }
    }
    
    // Try memory first
    let token = this.tokens.get(key);
    
    // Fallback to sessionStorage
    if (!token) {
      try {
        token = this.storage.getItem(key);
        if (token) {
          // Restore to memory
          this.tokens.set(key, token);
        }
      } catch (e) {
        console.warn('Failed to retrieve token from sessionStorage:', e);
      }
    }
    
    return token;
  }
  
  /**
   * Remove a token
   */
  removeToken(key) {
    this.tokens.delete(key);
    this.expirations.delete(key);
    
    try {
      this.storage.removeItem(key);
    } catch (e) {
      console.warn('Failed to remove token from sessionStorage:', e);
    }
    
    // Also clean up from localStorage if it exists
    try {
      localStorage.removeItem(key);
    } catch (e) {
      // Ignore
    }
  }
  
  /**
   * Clear all tokens
   */
  clearAll() {
    this.tokens.clear();
    this.expirations.clear();
    
    try {
      this.storage.clear();
    } catch (e) {
      console.warn('Failed to clear sessionStorage:', e);
    }
  }
  
  /**
   * Check if a token exists and is valid
   */
  hasToken(key) {
    return this.getToken(key) !== null;
  }
}

class OOBEApp {
  // WiFi scan configuration
  static WIFI_SCAN_MAX_RETRIES = 3;
  static WIFI_SCAN_RETRY_DELAY = 2000; // milliseconds
  
  // Auth0 Configuration (Public OAuth - no client secret)
  static AUTH0_CONFIG = {
    domain: 'tpr-prod.us.auth0.com',
    clientId: 'Id8RBRWK92AEYGcQgXkzlmBtC0MxsX2f',
    audience: 'https://thepolicerecord.com/api',
    scope: 'openid profile email offline_access'
  };

  // Platform API base URL
  // Default to dev environment for testing
  // Override at runtime by setting window.TPR_PLATFORM_URL before this script loads.
  static PLATFORM_API_URL = window.TPR_PLATFORM_URL || 'https://dev.thepolicerecord.com';

  constructor() {
    // Initialize secure token manager
    this.tokenManager = new SecureTokenManager();
    
    // Pass token manager to API for secure token handling
    this.api = new SupervisorAPI(null, this.tokenManager);
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
    
    // OAuth state
    this.oauthState = null;
    this.codeVerifier = null;
    
    // WiFi scan abort controller
    this.wifiScanController = null;
    
    // Set up auth failure handler
    this.api.onAuthFailure = (message) => this.handleAuthFailure(message);
    
    this.init();
  }

  async init() {
    console.log('Initializing OOBE...');
    this.hideLoading();
    
    // Check if we're returning from OAuth callback
    const urlParams = new URLSearchParams(window.location.search);
    const authCode = urlParams.get('code');
    const state = urlParams.get('state');
    const error = urlParams.get('error');
    
    if (error) {
      console.error('OAuth error:', error, urlParams.get('error_description'));
      this.showError('Sign-in failed: ' + (urlParams.get('error_description') || error));
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (authCode && state) {
      // Handle OAuth callback
      await this.handleOAuthCallback(authCode, state);
      return;
    }
    
    // Check if we have a stored token and validate it
    const storedToken = this.tokenManager.getToken('authToken');
    if (storedToken) {
      console.log('Found stored auth token, validating...');
      // Try a simple API call to validate the token
      const result = await this.api.queryUserInfo();
      if (result.success) {
        console.log('Stored token is valid');
        // Token is valid, but for OOBE we still start at step 1
        // The user can proceed through the flow
      } else if (result.authFailure) {
        console.log('Stored token is invalid, clearing...');
        // Token is invalid, already cleared by API
      }
    }
    
    // Start at step 1 (Welcome)
    // We'll login when the user provides the old password in step 2
    this.showStep(1);
  }

  /**
   * Handle authentication failures (401 errors)
   * This is called when the API detects an invalid/expired token
   */
  handleAuthFailure(message) {
    console.warn('Auth failure detected:', message);
    this.hideLoading();
    
    // If we're past the password step, we need to go back
    if (this.currentStep > 2) {
      this.showError('Session expired. Please enter your password again.');
      // Go back to password step
      this.showStep(2);
    }
  }

  /**
   * Make an authenticated fetch request with proper error handling
   * Use this instead of direct fetch() calls for API endpoints
   */
  async authenticatedFetch(url, options = {}) {
    const token = this.tokenManager.getToken('authToken');
    
    // Set up headers with auth token
    const headers = {
      ...options.headers,
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    const response = await fetch(url, { ...options, headers });
    
    // Handle 401 errors
    if (response.status === 401) {
      console.warn(`[OOBE] Auth failure (401) for ${options.method || 'GET'} ${url}`);
      this.tokenManager.removeToken('authToken');
      this.handleAuthFailure('Token expired or invalid');
      throw new Error('Authentication required');
    }
    
    return response;
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
        this.loadRegistrationStep();
        break;
      case 6:
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
        console.warn('Could not detect timezone:', e.message);
        // User will need to select manually
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
    const maxRetries = OOBEApp.WIFI_SCAN_MAX_RETRIES;
    const retryDelay = OOBEApp.WIFI_SCAN_RETRY_DELAY;
    
    // Cancel any existing scan
    if (this.wifiScanController) {
      this.wifiScanController.abort();
    }
    
    // Create new abort controller for this scan
    this.wifiScanController = new AbortController();
    const signal = this.wifiScanController.signal;
    
    this.showLoading('Scanning for WiFi networks...');
    
    try {
      // Check if we have a valid token before attempting WiFi scan
      const token = this.tokenManager.getToken('authToken');
      if (!token) {
        this.hideLoading();
        this.showError('Authentication required. Please go back and login again.');
        console.error('No auth token found in secure storage');
        return;
      }
      
      // Check if scan was aborted
      if (signal.aborted) {
        console.log('WiFi scan was cancelled');
        return;
      }
      
      console.log(`Scanning WiFi (attempt ${retryCount + 1}/${maxRetries + 1}) with token:`, token.substring(0, 20) + '...');
      const result = await this.api.getWiFiInfoList();
      
      // Check if scan was aborted after API call
      if (signal.aborted) {
        console.log('WiFi scan was cancelled');
        return;
      }
      
      if (result.success && result.data) {
        // The API returns wifiInfoList, not networks
        const networks = result.data.wifiInfoList || [];
        console.log('Found', networks.length, 'WiFi networks');
        
        // If no networks found and we haven't exhausted retries, wait and try again
        if (networks.length === 0 && retryCount < maxRetries) {
          console.log(`No networks found, retrying in ${retryDelay}ms...`);
          this.showLoading(`Scanning for WiFi networks... (attempt ${retryCount + 2}/${maxRetries + 1})`);
          
          // Use abortable timeout
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(resolve, retryDelay);
            signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              reject(new Error('Scan cancelled'));
            });
          }).catch(() => {
            console.log('Retry cancelled');
            return;
          });
          
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
        // Standardized error handling
        this.handleAPIError(result, 'WiFi scan');
      }
    } catch (error) {
      if (error.name === 'AbortError' || error.message === 'Scan cancelled') {
        console.log('WiFi scan cancelled by user');
        return;
      }
      console.error('WiFi scan error:', error);
      this.showError('Failed to scan WiFi networks: ' + error.message);
    } finally {
      this.hideLoading();
      this.wifiScanController = null;
    }
  }

  async rescanWiFi() {
    console.log('User requested WiFi rescan');
    await this.scanWiFiNetworks();
  }
  
  /**
   * Standardized API error handler
   */
  handleAPIError(result, operation) {
    if (result.code === 401) {
      this.showError(`Authentication failed during ${operation}. Please go back and login again.`);
      console.error(`${operation} auth error:`, result);
    } else if (result.code === 403) {
      this.showError(`Permission denied for ${operation}.`);
      console.error(`${operation} permission error:`, result);
    } else if (result.code === 404) {
      this.showError(`${operation} endpoint not found.`);
      console.error(`${operation} not found:`, result);
    } else if (result.code >= 500) {
      this.showError(`Server error during ${operation}. Please try again later.`);
      console.error(`${operation} server error:`, result);
    } else {
      this.showError(`Failed to ${operation}: ${result.error || result.msg || 'Unknown error'}`);
      console.error(`${operation} error:`, result);
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
      item.onclick = (event) => this.selectWiFiNetwork(network.ssid, network.security, event);

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

  selectWiFiNetwork(ssid, security, event) {
    this.setupData.wifiSSID = ssid;
    this.setupData.wifiSecurity = security;

    // Update UI
    document.querySelectorAll('.wifi-item').forEach(el => {
      el.classList.remove('selected');
    });
    if (event && event.currentTarget) {
      event.currentTarget.classList.add('selected');
    }

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
    // Return different signal strength indicators
    if (signal >= -50) return '📶📶📶'; // Excellent
    if (signal >= -60) return '📶📶';   // Good
    if (signal >= -70) return '📶';     // Fair
    return '📡';                        // Weak
  }

  loadCompletionStep() {
    console.log('Loading completion step with data:', this.setupData);
    const summaryEl = document.getElementById('setup-summary');
    
    // Ensure we have values, provide defaults if missing
    const deviceName = this.setupData.deviceName || 'Not set';
    const timezone = this.setupData.timezone || 'Not set';
    const wifiSSID = this.setupData.wifiSSID || 'Not configured';
    
    summaryEl.innerHTML = `
      <div class="device-info">
        <div class="device-info-item">
          <span class="device-info-label">Device Name:</span>
          <span class="device-info-value">${this.escapeHtml(deviceName)}</span>
        </div>
        <div class="device-info-item">
          <span class="device-info-label">Timezone:</span>
          <span class="device-info-value">${this.escapeHtml(timezone)}</span>
        </div>
        <div class="device-info-item">
          <span class="device-info-label">WiFi Network:</span>
          <span class="device-info-value">${this.escapeHtml(wifiSSID)}</span>
        </div>
      </div>
    `;
  }

  // Step Actions

  async handleWelcomeNext() {
    this.showStep(2);
  }

  /**
   * Validate password strength
   */
  validatePassword(password) {
    if (!password || password.length < 8) {
      return { valid: false, message: 'Password must be at least 8 characters long' };
    }
    
    if (password.length > 128) {
      return { valid: false, message: 'Password must be less than 128 characters' };
    }
    
    // Check for at least one uppercase letter
    if (!/[A-Z]/.test(password)) {
      return { valid: false, message: 'Password must contain at least one uppercase letter' };
    }
    
    // Check for at least one lowercase letter
    if (!/[a-z]/.test(password)) {
      return { valid: false, message: 'Password must contain at least one lowercase letter' };
    }
    
    // Check for at least one number
    if (!/\d/.test(password)) {
      return { valid: false, message: 'Password must contain at least one number' };
    }
    
    // Check for at least one special character
    if (!/[@$!%*?&#^()_+\-=\[\]{};':"\\|,.<>\/]/.test(password)) {
      return { valid: false, message: 'Password must contain at least one special character (@$!%*?&#, etc.)' };
    }
    
    // Check for common weak passwords
    const weakPasswords = ['Password1!', 'Admin123!', 'Welcome1!', 'Qwerty123!'];
    if (weakPasswords.some(weak => password.toLowerCase().includes(weak.toLowerCase()))) {
      return { valid: false, message: 'Password is too common. Please choose a more unique password' };
    }
    
    return { valid: true };
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

    // Comprehensive password validation
    const validation = this.validatePassword(newPassword);
    if (!validation.valid) {
      this.showError(validation.message);
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
    
    // Store password temporarily in a secure way for re-authentication
    // Use a closure to avoid storing in setupData
    const securePassword = newPassword;
    
    // Define re-auth function that uses the closure
    this.reAuthenticateAfterTimeChange = async () => {
      let loginResult = await this.api.login('recamera', securePassword);
      if (!loginResult.success) {
        loginResult = await this.api.login('admin', securePassword);
      }
      return loginResult;
    };

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
    
    // Store device name in sessionStorage so it persists across OAuth redirect
    sessionStorage.setItem('oobe_device_name', deviceName);
    sessionStorage.setItem('oobe_timezone', timezone);

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
    // Note: Changing system time can invalidate JWT tokens if the new time
    // is before the token's NotBefore claim. We need to re-login after.
    const dateTimeString = `${dateValue}T${timeValue}:00`;
    const timestamp = Math.floor(new Date(dateTimeString).getTime() / 1000);
    const timeResult = await this.api.setTimestamp(timestamp);
    if (!timeResult.success) {
      console.warn('Failed to set timestamp:', timeResult.error);
      // Don't fail the setup if time sync fails
    } else {
      // System time changed - re-login to get a fresh token with correct timestamps
      // This is necessary because the old token's NotBefore claim may now be in the "future"
      console.log('System time changed, re-authenticating to get fresh token...');
      if (this.reAuthenticateAfterTimeChange) {
        const loginResult = await this.reAuthenticateAfterTimeChange();
        if (loginResult.success) {
          console.log('Re-authentication successful after time change');
        } else {
          console.warn('Re-authentication failed after time change:', loginResult.error);
        }
      } else {
        console.warn('No re-authentication function available after time change');
      }
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

  // Camera Registration Step (OAuth-based)

  async loadRegistrationStep() {
    console.log('Loading camera registration step');

    // Always reset UI first so stale state doesn't bleed between steps/runs
    this.showRegistrationPrompt();

    // IMPORTANT:
    // Do NOT infer "camera registered" from a browser-stored OAuth token.
    // Users often run OOBE from the same phone/laptop for multiple cameras;
    // localStorage persists across devices and would incorrectly skip login.
    //
    // Instead, ask the device (OOBE server) whether the camera has been
    // registered previously by checking the on-device registration file.
    try {
      const resp = await fetch('/oobe/api/registrationStatus', {
        headers: { 'Accept': 'application/json' }
      });

      if (!resp.ok) {
        console.warn('Failed to check registration status:', resp.status);
        return;
      }

      const status = await resp.json();
      if (status?.ok && status?.registered) {
        this.showRegistrationSuccess();
      }
    } catch (e) {
      console.warn('Error checking registration status:', e);
      // If status check fails (e.g., offline), default to prompting sign-in.
    }
  }

  /**
   * Reset registration UI to the default "please sign in" state.
   */
  showRegistrationPrompt() {
    // Show sign-in section
    const signinSection = document.getElementById('signin-section');
    if (signinSection) {
      signinSection.classList.remove('hidden');
    }

    // Hide success section
    const successSection = document.getElementById('registration-success');
    if (successSection) {
      successSection.classList.add('hidden');
    }

    // Hide continue button until registration succeeds
    const continueBtn = document.getElementById('continue-after-registration-btn');
    if (continueBtn) {
      continueBtn.classList.add('hidden');
    }

    // Hide any prior status banner
    const statusEl = document.getElementById('registration-status');
    if (statusEl) {
      statusEl.classList.add('hidden');
    }
  }

  /**
   * Generate a cryptographically random string for PKCE
   */
  generateRandomString(length) {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);
    return Array.from(randomValues)
      .map(v => charset[v % charset.length])
      .join('');
  }

  /**
   * Generate SHA-256 hash and base64url encode it for PKCE
   */
  async generateCodeChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    
    // Base64url encode
    const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    return base64
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /**
   * Initiate OAuth sign-in flow with Auth0 using PKCE
   */
  async handleOAuthSignIn() {
    try {
      this.showLoading('Preparing sign-in...');
      
      // Generate PKCE code verifier and challenge
      this.codeVerifier = this.generateRandomString(64);
      const codeChallenge = await this.generateCodeChallenge(this.codeVerifier);
      
      // Generate state for CSRF protection
      this.oauthState = this.generateRandomString(32);
      
      // Store in sessionStorage for callback with timestamp for expiration
      const expiresAt = Date.now() + (10 * 60 * 1000); // 10 minutes
      sessionStorage.setItem('oauth_code_verifier', this.codeVerifier);
      sessionStorage.setItem('oauth_state', this.oauthState);
      sessionStorage.setItem('oauth_step', this.currentStep.toString());
      sessionStorage.setItem('oauth_expires_at', expiresAt.toString());
      
      // Build authorization URL
      const { domain, clientId, audience, scope } = OOBEApp.AUTH0_CONFIG;
      // Use /api/deviceMgr/oauthCallback for the OAuth redirect
      // This bypasses the OOBE proxy and is handled directly by the supervisor
      // The supervisor then redirects to /oobe/index.html with the code and state
      const redirectUri = `${window.location.origin}/api/deviceMgr/oauthCallback`;
      
      const authUrl = new URL(`https://${domain}/authorize`);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', scope);
      authUrl.searchParams.set('audience', audience);
      authUrl.searchParams.set('state', this.oauthState);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      
      console.log('Redirecting to Auth0 for sign-in...');
      this.hideLoading();
      
      // Redirect to Auth0
      window.location.href = authUrl.toString();
      
    } catch (error) {
      console.error('Failed to initiate OAuth sign-in:', error);
      this.hideLoading();
      this.showError('Failed to start sign-in: ' + error.message);
    }
  }

  /**
   * Handle OAuth callback after Auth0 redirect
   */
  async handleOAuthCallback(code, state) {
    console.log('Handling OAuth callback...');
    
    // Check if OAuth state has expired
    const expiresAt = sessionStorage.getItem('oauth_expires_at');
    if (expiresAt && Date.now() > parseInt(expiresAt)) {
      console.error('OAuth state expired');
      this.showError('Sign-in session expired. Please try again.');
      sessionStorage.removeItem('oauth_code_verifier');
      sessionStorage.removeItem('oauth_state');
      sessionStorage.removeItem('oauth_step');
      sessionStorage.removeItem('oauth_expires_at');
      window.history.replaceState({}, document.title, window.location.pathname);
      this.showStep(5);
      return;
    }
    
    // Verify state
    const storedState = sessionStorage.getItem('oauth_state');
    if (state !== storedState) {
      console.error('OAuth state mismatch');
      this.showError('Security error: Invalid state. Please try signing in again.');
      window.history.replaceState({}, document.title, window.location.pathname);
      this.showStep(5);
      return;
    }
    
    // Get stored code verifier
    const codeVerifier = sessionStorage.getItem('oauth_code_verifier');
    if (!codeVerifier) {
      console.error('No code verifier found');
      this.showError('Session error: Please try signing in again.');
      window.history.replaceState({}, document.title, window.location.pathname);
      this.showStep(5);
      return;
    }
    
    // Clean up URL
    window.history.replaceState({}, document.title, window.location.pathname);
    
    this.showLoading('Completing sign-in...');
    
    try {
      // Exchange code for tokens
      const { domain, clientId } = OOBEApp.AUTH0_CONFIG;
      // Must match the redirect URI used in the authorization request
      const redirectUri = `${window.location.origin}/api/deviceMgr/oauthCallback`;
      
      const tokenResponse = await fetch(`https://${domain}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: clientId,
          code_verifier: codeVerifier,
          code: code,
          redirect_uri: redirectUri
        })
      });
      
      if (!tokenResponse.ok) {
        const errorData = await tokenResponse.json().catch(() => ({}));
        throw new Error(errorData.error_description || errorData.error || 'Token exchange failed');
      }
      
      const tokens = await tokenResponse.json();
      console.log('OAuth tokens received');
      
      // Store tokens securely with expiration
      // Access tokens typically expire in 1 hour (3600 seconds)
      const expiresIn = tokens.expires_in || 3600;
      this.tokenManager.setToken('platformAccessToken', tokens.access_token, expiresIn);
      
      if (tokens.refresh_token) {
        // Refresh tokens typically last much longer (30 days)
        this.tokenManager.setToken('platformRefreshToken', tokens.refresh_token, 30 * 24 * 3600);
      }
      if (tokens.id_token) {
        // ID tokens have same expiration as access tokens
        this.tokenManager.setToken('platformIdToken', tokens.id_token, expiresIn);
      }
      
      // Get user info from ID token or userinfo endpoint
      let userInfo = null;
      if (tokens.id_token) {
        // Decode ID token (JWT) to get user info
        try {
          const payload = tokens.id_token.split('.')[1];
          userInfo = JSON.parse(atob(payload));
        } catch (e) {
          console.log('Could not decode ID token');
        }
      }
      
      // Register camera via supervisor single-call endpoint using the access token
      console.log('Calling registerCameraWithSupervisor...');
      await this.registerCameraWithSupervisor(tokens.access_token, userInfo);
      console.log('Registration completed successfully');
      
      // Clean up session storage
      sessionStorage.removeItem('oauth_code_verifier');
      sessionStorage.removeItem('oauth_state');
      sessionStorage.removeItem('oauth_step');
      sessionStorage.removeItem('oauth_expires_at');
      sessionStorage.removeItem('oobe_device_name');
      sessionStorage.removeItem('oobe_timezone');
      
      this.hideLoading();
      
      // Show success and go to step 5
      this.showStep(5);
      this.showRegistrationSuccess();
      
    } catch (error) {
      console.error('OAuth callback error:', error);
      this.hideLoading();
      this.showError('Sign-in failed: ' + error.message);
      
      // Clean up
      sessionStorage.removeItem('oauth_code_verifier');
      sessionStorage.removeItem('oauth_state');
      sessionStorage.removeItem('oauth_step');
      sessionStorage.removeItem('oauth_expires_at');
      
      // Go to registration step
      this.showStep(5);
    }
  }

  /**
   * Register camera by asking the supervisor to perform the full platform
   * registration flow. This sends the OAuth access token to the supervisor
   * and a minimal registration payload (location_name, lat/lon).
   * The supervisor automatically populates device-specific fields (serial number,
   * MAC addresses, firmware version, etc.) from its internal device information.
   */
  async registerCameraWithSupervisor(accessToken, userInfo) {
    console.log('Registering camera via supervisor single-call...');

    // Collect geolocation if available
    const geolocation = this.setupData.geolocation || {};
  
    // Get device name from setup data, sessionStorage, or input field
    // After OAuth redirect, setupData may be lost, so check sessionStorage
    let deviceName = this.setupData.deviceName;
    if (!deviceName) {
      // Try sessionStorage (persists across OAuth redirect)
      deviceName = sessionStorage.getItem('oobe_device_name');
      if (deviceName) {
        console.log('Restored device name from sessionStorage:', deviceName);
        this.setupData.deviceName = deviceName;
      }
    }
    if (!deviceName) {
      // Try to get from the input field if still available
      const deviceNameInput = document.getElementById('device-name');
      if (deviceNameInput) {
        deviceName = deviceNameInput.value.trim();
      }
    }
    
    // Log for debugging
    console.log('Device name for registration:', deviceName || 'Unknown Location');
    console.log('Setup data:', this.setupData);
  
    // Send minimal payload with OAuth token - supervisor will fill in device details
    const registrationPayload = {
      access_token: accessToken,  // Auth0 OAuth access token
      location_name: deviceName || 'Unknown Location'
    };
    
    // Only include lat/lon if available
    if (geolocation.latitude) {
      registrationPayload.latitude = geolocation.latitude;
    }
    if (geolocation.longitude) {
      registrationPayload.longitude = geolocation.longitude;
    }

    console.log('Sending minimal registration payload (with OAuth token)');

    // Get supervisor JWT token from secure storage for authentication
    const supervisorToken = this.tokenManager.getToken('authToken');
    if (!supervisorToken) {
      throw new Error('No supervisor authentication token found. Please login again.');
    }

    // Get CSRF token if available (for future implementation)
    const csrfToken = this.getCSRFToken();
    
    // Call supervisor register endpoint with supervisor JWT token for auth
    // and OAuth access token in the body
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${supervisorToken}`  // Supervisor JWT token
    };
    
    // Add CSRF token if available
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }
    
    const resp = await fetch('/api/deviceMgr/registerCamera', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(registrationPayload)
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error('Supervisor registerCamera failed:', resp.status, text);
      throw new Error('Supervisor registration failed: ' + resp.status);
    }

    const result = await resp.json().catch(() => null);
    if (!result) {
      throw new Error('Invalid response from supervisor');
    }

    console.log('Raw supervisor response:', result);

    // Check if supervisor returned an error
    if (result.code !== 0 && result.code !== undefined) {
      console.error('Supervisor returned error code:', result.code, result.msg);
      throw new Error(result.msg || 'Registration failed');
    }

    // Supervisor may wrap platform response in { code: 0, data: { ... } }
    const payload = result.code === 0 ? result.data : result;

    console.log('Supervisor registration result:', payload);

    // Build a minimal registration record for OOBE status tracking.
    // DO NOT store secrets, user info, or anything that ties to a specific user.
    // This file is only used to check if OOBE has been completed.
    // The supervisor stores the actual secret_key securely in /etc/recamera.conf/platform.info
    const registrationData = {
      registered: true,
      registered_at: new Date().toISOString(),
      camera_uid: payload?.uid || payload?.camera_uid || null
    };

    await this.saveRegistrationData(registrationData);
  }

  /**
   * Show registration success UI
   */
  showRegistrationSuccess() {
    // Hide sign-in section
    const signinSection = document.getElementById('signin-section');
    if (signinSection) {
      signinSection.classList.add('hidden');
    }
    
    // Show success section
    const successSection = document.getElementById('registration-success');
    if (successSection) {
      successSection.classList.remove('hidden');
    }
    
    // Show continue button
    const continueBtn = document.getElementById('continue-after-registration-btn');
    if (continueBtn) {
      continueBtn.classList.remove('hidden');
    }
    
    // Update status
    this.updateRegistrationStatus('Camera registered successfully!', 'success', '✓');
  }

  /**
   * Update registration status display
   */
  updateRegistrationStatus(message, type, icon = '') {
    const statusEl = document.getElementById('registration-status');
    const textEl = document.getElementById('registration-status-text');
    const iconEl = document.getElementById('registration-status-icon');
    
    if (statusEl && textEl) {
      textEl.textContent = message;
      statusEl.className = 'registration-status ' + type;
      statusEl.classList.remove('hidden');
      
      if (iconEl && icon) {
        iconEl.textContent = icon;
      }
    }
  }


  /**
   * Get CSRF token from meta tag or cookie
   */
  getCSRFToken() {
    // Try to get from meta tag first
    const metaTag = document.querySelector('meta[name="csrf-token"]');
    if (metaTag) {
      return metaTag.getAttribute('content');
    }
    
    // Try to get from cookie
    const cookies = document.cookie.split(';');
    for (let cookie of cookies) {
      const [name, value] = cookie.trim().split('=');
      if (name === 'CSRF-TOKEN' || name === 'csrf_token') {
        return decodeURIComponent(value);
      }
    }
    
    return null;
  }

  async saveRegistrationData(registrationData) {
    try {
      const csrfToken = this.getCSRFToken();
      const headers = {
        'Content-Type': 'application/json',
      };
      
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }
      
      const response = await fetch('/oobe/api/saveRegistration', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(registrationData)
      });
      
      const result = await response.json();
      if (!result.ok) {
        throw new Error(result.error || 'Failed to save registration');
      }
      
      console.log('Registration data saved successfully');
    } catch (error) {
      console.error('Error saving registration:', error);
      throw error;
    }
  }

  handleRegistrationSkip() {
    if (confirm('Are you sure you want to skip camera registration? You can register later from the settings page.')) {
      this.showStep(6);
    }
  }

  handleRegistrationComplete() {
    this.showStep(6);
  }

  showInfo(message) {
    // Similar to showError but with info styling
    const alertEl = document.getElementById('error-alert');
    const messageEl = document.getElementById('error-message');
    
    if (alertEl && messageEl) {
      // Change to info styling
      const alertDiv = alertEl.querySelector('.alert');
      if (alertDiv) {
        alertDiv.className = 'alert alert-info';
      }
      
      messageEl.innerHTML = '<strong>Info:</strong> ' + message;
      alertEl.classList.remove('hidden');
      
      // Auto-hide after 8 seconds
      setTimeout(() => {
        alertEl.classList.add('hidden');
      }, 8000);
    }
  }

  async handleComplete() {
    this.showLoading('Finalizing setup...');

    // Optional: Set LED to indicate completion
    try {
      await this.api.setLED('led0', 255, 'heartbeat');
    } catch (e) {
      console.log('Could not set LED');
    }

    // Signal OOBE completion - removes /etc/oobe/flag
    try {
      await fetch('/oobe/api/complete', { method: 'POST' });
      console.log('OOBE flag removed');
    } catch (e) {
      console.error('Error completing OOBE:', e);
    }

    this.hideLoading();

    // Show success message
    document.getElementById('completion-message').innerHTML = `
      <div class="alert alert-success">
        <strong>Setup Complete!</strong><br>
        Your Authority Alert device is ready to use.
      </div>
    `;

    // Redirect to main dashboard after a delay
    setTimeout(() => {
      window.location.href = '/';
    }, 2000);
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
