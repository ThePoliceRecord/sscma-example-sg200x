import { useState, useEffect } from "react";
import { Radio, Select, Button, Input, message, Spin } from "antd";
import { CloudDownloadOutlined, SyncOutlined, CheckCircleOutlined, LinkOutlined } from "@ant-design/icons";
import type { RadioChangeEvent } from "antd";
import { getUpdateConfigApi, setUpdateConfigApi, UpdateConfig as APIUpdateConfig, updateSystemApi } from "@/api/device";

// Update source options
type UpdateSource = "tpr_official" | "self_hosted";

// Update check frequency options
type UpdateFrequency = "30min" | "daily" | "weekly" | "manual";

// Day of week for weekly updates
type DayOfWeek = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";

// Update configuration state
interface UpdateConfig {
  osSource: UpdateSource;
  modelSource: UpdateSource;
  selfHostedOSUrl: string;
  selfHostedModelUrl: string;
  checkFrequency: UpdateFrequency;
  weeklyDay: DayOfWeek;
}

// Update info
interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  lastChecked: string;
}

// Translucent card style (matching TPR.css .translucent-card-grey-1)
const translucentCardStyle = {
  backgroundColor: 'rgba(31, 31, 27, 0.85)',
  boxShadow: '2px 2px 4px 4px rgba(3, 68, 255, 0.4), -2px -2px 4px 4px rgba(3, 68, 255, 0.2)',
  borderRadius: '12px',
};

const dayOptions = [
  { value: "sunday", label: "Sunday" },
  { value: "monday", label: "Monday" },
  { value: "tuesday", label: "Tuesday" },
  { value: "wednesday", label: "Wednesday" },
  { value: "thursday", label: "Thursday" },
  { value: "friday", label: "Friday" },
  { value: "saturday", label: "Saturday" },
];

const frequencyOptions = [
  { value: "30min", label: "Every 30 minutes" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "manual", label: "Manual only" },
];

function Updates() {
  const [messageApi, contextHolder] = message.useMessage();
  const [loading, setLoading] = useState(false);
  
  const [config, setConfig] = useState<UpdateConfig>({
    osSource: "tpr_official",
    modelSource: "tpr_official",
    selfHostedOSUrl: "",
    selfHostedModelUrl: "",
    checkFrequency: "daily",
    weeklyDay: "sunday",
  });

  // Load configuration on mount
  useEffect(() => {
    const loadConfig = async () => {
      setLoading(true);
      try {
        const response = await getUpdateConfigApi();
        setConfig({
          osSource: response.data.os_source,
          modelSource: response.data.model_source,
          selfHostedOSUrl: response.data.self_hosted_os_url,
          selfHostedModelUrl: response.data.self_hosted_model_url,
          checkFrequency: response.data.check_frequency,
          weeklyDay: response.data.weekly_day,
        });
      } catch (error) {
        console.error("Failed to load update configuration:", error);
        messageApi.error("Failed to load update configuration");
      } finally {
        setLoading(false);
      }
    };
    loadConfig();
  }, [messageApi]);

  // Save configuration helper
  const saveConfig = async (newConfig: UpdateConfig) => {
    try {
      const apiConfig: APIUpdateConfig = {
        os_source: newConfig.osSource,
        model_source: newConfig.modelSource,
        self_hosted_os_url: newConfig.selfHostedOSUrl,
        self_hosted_model_url: newConfig.selfHostedModelUrl,
        check_frequency: newConfig.checkFrequency,
        weekly_day: newConfig.weeklyDay,
      };
      await setUpdateConfigApi(apiConfig);
    } catch (error) {
      console.error("Failed to save update configuration:", error);
      throw error;
    }
  };

  const [osUpdateInfo] = useState<UpdateInfo>({
    currentVersion: "1.2.3",
    latestVersion: "1.2.3",
    hasUpdate: false,
    lastChecked: "2 hours ago",
  });

  const [modelUpdateInfo] = useState<UpdateInfo>({
    currentVersion: "2.0.1",
    latestVersion: "2.1.0",
    hasUpdate: true,
    lastChecked: "2 hours ago",
  });

  const [checkingOS, setCheckingOS] = useState(false);
  const [checkingModel, setCheckingModel] = useState(false);

  const handleOSSourceChange = async (e: RadioChangeEvent) => {
    const newConfig = {
      ...config,
      osSource: e.target.value as UpdateSource,
    };
    setConfig(newConfig);
    try {
      await saveConfig(newConfig);
      messageApi.success("Update source saved");
    } catch (error) {
      messageApi.error("Failed to save update source");
    }
  };

  const handleModelSourceChange = async (e: RadioChangeEvent) => {
    const newConfig = {
      ...config,
      modelSource: e.target.value as UpdateSource,
    };
    setConfig(newConfig);
    try {
      await saveConfig(newConfig);
      messageApi.success("Update source saved");
    } catch (error) {
      messageApi.error("Failed to save update source");
    }
  };

  const handleSelfHostedOSUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setConfig((prev) => ({
      ...prev,
      selfHostedOSUrl: e.target.value,
    }));
  };

  const handleSelfHostedModelUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setConfig((prev) => ({
      ...prev,
      selfHostedModelUrl: e.target.value,
    }));
  };

  const handleFrequencyChange = async (value: UpdateFrequency) => {
    const newConfig = {
      ...config,
      checkFrequency: value,
    };
    setConfig(newConfig);
    try {
      await saveConfig(newConfig);
      messageApi.success("Update frequency saved");
    } catch (error) {
      messageApi.error("Failed to save update frequency");
    }
  };

  const handleWeeklyDayChange = async (value: DayOfWeek) => {
    const newConfig = {
      ...config,
      weeklyDay: value,
    };
    setConfig(newConfig);
    try {
      await saveConfig(newConfig);
      messageApi.success("Weekly day saved");
    } catch (error) {
      messageApi.error("Failed to save weekly day");
    }
  };

  const handleCheckOSUpdates = async () => {
    if (config.osSource === "self_hosted" && !config.selfHostedOSUrl.trim()) {
      messageApi.error("Please enter a self-hosted server URL");
      return;
    }
    setCheckingOS(true);
    // Simulate API call
    await new Promise((resolve) => setTimeout(resolve, 2000));
    setCheckingOS(false);
    messageApi.info("Camera OS is up to date");
  };

  const handleCheckModelUpdates = async () => {
    if (config.modelSource === "self_hosted" && !config.selfHostedModelUrl.trim()) {
      messageApi.error("Please enter a self-hosted server URL");
      return;
    }
    setCheckingModel(true);
    // Simulate API call
    await new Promise((resolve) => setTimeout(resolve, 2000));
    setCheckingModel(false);
    messageApi.success("New model update available!");
  };

  const handleInstallUpdate = async (type: "os" | "model") => {
    try {
      await updateSystemApi();
      messageApi.info(`Installing ${type === "os" ? "Camera OS" : "Camera Model"} update...`);
    } catch (error) {
      console.error("Failed to start update:", error);
      messageApi.error("Failed to start update");
    }
  };

  // Render update card
  const renderUpdateCard = (
    title: string,
    info: UpdateInfo,
    source: UpdateSource,
    selfHostedUrl: string,
    onSourceChange: (e: RadioChangeEvent) => void,
    onUrlChange: (e: React.ChangeEvent<HTMLInputElement>) => void,
    checking: boolean,
    onCheck: () => void,
    onInstall: () => void
  ) => (
    <div className="p-20" style={translucentCardStyle}>
      <div className="flex justify-between items-start mb-16">
        <div>
          <h3 className="text-18 font-semibold text-platinum m-0">{title}</h3>
          <div className="text-12 text-platinum/50 mt-4">
            Last checked: {info.lastChecked}
          </div>
        </div>
        {info.hasUpdate ? (
          <div className="px-12 py-4 rounded-full bg-cta/20 text-cta text-12 font-medium">
            Update Available
          </div>
        ) : (
          <div className="flex items-center gap-4 text-12 text-platinum/60">
            <CheckCircleOutlined style={{ color: '#9be564' }} />
            Up to date
          </div>
        )}
      </div>

      {/* Version Info */}
      <div className="mb-16 p-12 rounded-lg" style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)' }}>
        <div className="flex justify-between items-center mb-8">
          <span className="text-14 text-platinum/70">Current Version</span>
          <span className="text-14 text-platinum font-mono">{info.currentVersion}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-14 text-platinum/70">Latest Version</span>
          <span className={`text-14 font-mono ${info.hasUpdate ? 'text-cta' : 'text-platinum'}`}>
            {info.latestVersion}
          </span>
        </div>
      </div>

      {/* Source Selection */}
      <div className="mb-16">
        <div className="text-14 font-medium text-platinum mb-8">Update Source</div>
        <Radio.Group
          value={source}
          onChange={onSourceChange}
          optionType="button"
          buttonStyle="solid"
          className="w-full"
        >
          <Radio.Button value="tpr_official" className="w-1/2 text-center">
            TPR Official
          </Radio.Button>
          <Radio.Button value="self_hosted" className="w-1/2 text-center">
            Self Hosted
          </Radio.Button>
        </Radio.Group>
        <div className="text-11 text-platinum/40 mt-8">
          {source === "tpr_official" 
            ? "Official updates from The Police Record servers. Recommended for most users."
            : "Use your own update server for custom deployments."}
        </div>
      </div>

      {/* Self-Hosted URL Input */}
      {source === "self_hosted" && (
        <div className="mb-16">
          <div className="text-14 font-medium text-platinum mb-8">Server URL</div>
          <Input
            prefix={<LinkOutlined style={{ color: 'rgba(255, 255, 255, 0.5)' }} />}
            placeholder="https://your-update-server.com/api"
            value={selfHostedUrl}
            onChange={onUrlChange}
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.1)',
              borderColor: 'rgba(255, 255, 255, 0.2)',
              color: '#e0e0e0',
            }}
          />
          <div className="text-11 text-platinum/40 mt-4">
            Enter the full URL to your self-hosted update server endpoint
          </div>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-12">
        <Button
          icon={checking ? <Spin size="small" /> : <SyncOutlined />}
          onClick={onCheck}
          disabled={checking}
          className="flex-1"
        >
          {checking ? "Checking..." : "Check for Updates"}
        </Button>
        {info.hasUpdate && (
          <Button
            type="primary"
            icon={<CloudDownloadOutlined />}
            onClick={onInstall}
            className="flex-1"
          >
            Install Update
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <div className="p-16">
      {contextHolder}
      
      {/* Page Header */}
      <div className="mb-24">
        <div className="flex items-center gap-12 mb-8">
          <CloudDownloadOutlined style={{ fontSize: 28, color: '#9be564' }} />
          <h1 className="text-28 font-bold text-platinum m-0">Updates</h1>
        </div>
        <p className="text-14 text-platinum/60 mt-8">
          Keep your camera software and models up to date
        </p>
      </div>

      {/* Camera OS Updates */}
      <div className="mb-24">
        <div className="font-bold text-16 mb-12 text-platinum/70 uppercase tracking-wide">
          Camera OS Updates
        </div>
        {renderUpdateCard(
          "Camera OS",
          osUpdateInfo,
          config.osSource,
          config.selfHostedOSUrl,
          handleOSSourceChange,
          handleSelfHostedOSUrlChange,
          checkingOS,
          handleCheckOSUpdates,
          () => handleInstallUpdate("os")
        )}
      </div>

      {/* Camera Model Updates */}
      <div className="mb-24">
        <div className="font-bold text-16 mb-12 text-platinum/70 uppercase tracking-wide">
          Camera Model Updates
        </div>
        {renderUpdateCard(
          "Camera Model",
          modelUpdateInfo,
          config.modelSource,
          config.selfHostedModelUrl,
          handleModelSourceChange,
          handleSelfHostedModelUrlChange,
          checkingModel,
          handleCheckModelUpdates,
          () => handleInstallUpdate("model")
        )}
      </div>

      {/* Update Check Frequency */}
      <div className="mb-24">
        <div className="font-bold text-16 mb-12 text-platinum/70 uppercase tracking-wide">
          Update Check Frequency
        </div>
        <div className="p-20" style={translucentCardStyle}>
          <div className="mb-16">
            <div className="text-14 font-medium text-platinum mb-8">Check for updates</div>
            <Select
              value={config.checkFrequency}
              onChange={handleFrequencyChange}
              options={frequencyOptions}
              className="w-full"
              style={{ backgroundColor: 'rgba(255, 255, 255, 0.1)' }}
            />
          </div>

          {config.checkFrequency === "weekly" && (
            <div>
              <div className="text-14 font-medium text-platinum mb-8">Day of week</div>
              <Select
                value={config.weeklyDay}
                onChange={handleWeeklyDayChange}
                options={dayOptions}
                className="w-full"
                style={{ backgroundColor: 'rgba(255, 255, 255, 0.1)' }}
              />
            </div>
          )}

          <div className="mt-12 text-12 text-platinum/50">
            {config.checkFrequency === "manual" 
              ? "Updates will only be checked when you manually click 'Check for Updates'"
              : `Updates will be automatically checked ${
                  config.checkFrequency === "30min" ? "every 30 minutes" :
                  config.checkFrequency === "daily" ? "once per day" :
                  `every ${dayOptions.find(d => d.value === config.weeklyDay)?.label}`
                }`
            }
          </div>
        </div>
      </div>
    </div>
  );
}

export default Updates;
