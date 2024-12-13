// index.js
const fetch = require('node-fetch');

let Service, Characteristic;

class EnphaseBatteryPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = new Map();

    // Configuration
    this.systemId = config.systemId;
    this.apiKey = config.apiKey;
    this.accessToken = config.accessToken;
    
    // API endpoints
    this.apiBase = 'https://api.enphaseenergy.com/api/v4';
    
    // Required checks
    if (!this.systemId || !this.apiKey || !this.accessToken) {
      this.log.error('Missing required configuration. Please check your config.json');
      return;
    }

    // Initialize when loaded
    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }

  async discoverDevices() {
    try {
      // Get battery info from Enphase API
      const response = await fetch(
        `${this.apiBase}/systems/${this.systemId}/telemetry/battery`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'key': this.apiKey
          }
        }
      );

      if (!response.ok) {
        throw new Error(`API response: ${response.status}`);
      }

      const data = await response.json();
      
      // Generate a unique ID for this battery
      const uuid = this.api.hap.uuid.generate(`enphase-battery-${this.systemId}`);
      
      // See if we already have this accessory
      let batteryAccessory = this.accessories.get(uuid);
      
      if (!batteryAccessory) {
        // Create new accessory
        this.log.info('Adding new battery accessory');
        const displayName = this.config.name || 'Enphase Battery';
        batteryAccessory = new this.api.platformAccessory(displayName, uuid);
        
        // Register the accessory
        this.api.registerPlatformAccessories('homebridge-enphase-battery', 'EnphaseBattery', [batteryAccessory]);
        this.accessories.set(uuid, batteryAccessory);
      }

      // Configure battery service
      this.configureBatteryService(batteryAccessory);

      // Configure contact sensor service for charging state
      this.configureContactSensorService(batteryAccessory);
      
      // Start polling for updates
      this.startPolling();

    } catch (error) {
      this.log.error('Error discovering devices:', error);
    }
  }

  configureBatteryService(accessory) {
    // Get or add battery service
    let batteryService = accessory.getService(Service.BatteryService);
    if (!batteryService) {
      batteryService = accessory.addService(Service.BatteryService);
    }

    // Battery Level Characteristic
    batteryService
      .getCharacteristic(Characteristic.BatteryLevel)
      .onGet(this.getBatteryLevel.bind(this));

    // Charging State Characteristic
    batteryService
      .getCharacteristic(Characteristic.ChargingState)
      .onGet(this.getChargingState.bind(this));

    // Status Low Battery Characteristic
    batteryService
      .getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(this.getLowBatteryStatus.bind(this));
  }

  configureContactSensorService(accessory) {
    // Get or add contact sensor service
    let contactSensorService = accessory.getService(Service.ContactSensor) ||
      accessory.addService(Service.ContactSensor, 'Battery Charging', 'charging');

    // Set initial state
    contactSensorService
      .getCharacteristic(Characteristic.ContactSensorState)
      .onGet(this.getContactSensorState.bind(this));
  }

  getContactSensorState() {
    // Return CONTACT_NOT_DETECTED (1) when charging, CONTACT_DETECTED (0) when not charging
    return this.isCharging ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  startPolling() {
    // Poll every 5 minutes
    setInterval(async () => {
      try {
        await this.updateBatteryStatus();
      } catch (error) {
        this.log.error('Error updating battery status:', error);
      }
    }, 5 * 60 * 1000);
  }

  async updateBatteryStatus() {
    try {
      const response = await fetch(
        `${this.apiBase}/systems/${this.systemId}/telemetry/battery`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'key': this.apiKey
          }
        }
      );

      if (!response.ok) {
        throw new Error(`API response: ${response.status}`);
      }

      const data = await response.json();
      
      // Update all battery accessories
      for (const accessory of this.accessories.values()) {
        const batteryService = accessory.getService(Service.BatteryService);
        const contactSensorService = accessory.getService(Service.ContactSensor);
        
        if (data.intervals && data.intervals.length > 0) {
          const lastInterval = data.intervals[data.intervals.length - 1];
          
          // Update battery level
          if (lastInterval.soc && lastInterval.soc.percent !== undefined) {
            this.currentBatteryLevel = lastInterval.soc.percent;
            batteryService.updateCharacteristic(
              Characteristic.BatteryLevel,
              this.currentBatteryLevel
            );
          }
          
          // Update charging state and contact sensor
          if (lastInterval.charge && lastInterval.discharge) {
            const isCharging = lastInterval.charge.enwh > 0;
            this.isCharging = isCharging;
            
            let chargingState = isCharging 
              ? Characteristic.ChargingState.CHARGING 
              : Characteristic.ChargingState.NOT_CHARGING;
            
            batteryService.updateCharacteristic(
              Characteristic.ChargingState,
              chargingState
            );

            // Update contact sensor state
            contactSensorService.updateCharacteristic(
              Characteristic.ContactSensorState,
              isCharging ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : Characteristic.ContactSensorState.CONTACT_DETECTED
            );
          }
          
          // Update low battery status
          const lowBatteryStatus = this.currentBatteryLevel < 20 
            ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW 
            : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
          
          batteryService.updateCharacteristic(
            Characteristic.StatusLowBattery,
            lowBatteryStatus
          );
        }
      }
    } catch (error) {
      this.log.error('Error fetching battery status:', error);
      throw error;
    }
  }

  async getBatteryLevel() {
    try {
      await this.updateBatteryStatus();
      return this.currentBatteryLevel;
    } catch (error) {
      this.log.error('Error getting battery level:', error);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async getChargingState() {
    try {
      await this.updateBatteryStatus();
      return this.isCharging ? Characteristic.ChargingState.CHARGING : Characteristic.ChargingState.NOT_CHARGING;
    } catch (error) {
      this.log.error('Error getting charging state:', error);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async getLowBatteryStatus() {
    return this.currentBatteryLevel < 20 
      ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW 
      : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  configureAccessory(accessory) {
    // Add restored cached accessory to map
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }
}

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  
  api.registerPlatform('homebridge-enphase-battery', 'EnphaseBattery', EnphaseBatteryPlatform);
};