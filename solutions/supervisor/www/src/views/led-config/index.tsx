import { useState } from "react";
import { Switch, message } from "antd";
import { BulbOutlined, SaveOutlined } from "@ant-design/icons";

// LED configuration state
interface LEDConfig {
  whiteLED: boolean;
  blueLED: boolean;
  redLED: boolean;
  greenLED: boolean;
}

// Translucent card style (matching TPR.css .translucent-card-grey-1)
const translucentCardStyle = {
  backgroundColor: 'rgba(31, 31, 27, 0.85)',
  boxShadow: '2px 2px 4px 4px rgba(3, 68, 255, 0.4), -2px -2px 4px 4px rgba(3, 68, 255, 0.2)',
  borderRadius: '12px',
};

// LED configuration items
const ledItems: { key: keyof LEDConfig; label: string; description: string; color: string }[] = [
  {
    key: "whiteLED",
    label: "White Light LEDs",
    description: "Illumination LEDs for night vision",
    color: "#ffffff",
  },
  {
    key: "blueLED",
    label: "Blue LED",
    description: "Status indicator - typically shows connectivity",
    color: "#3b82f6",
  },
  {
    key: "redLED",
    label: "Red LED",
    description: "Status indicator - typically shows recording",
    color: "#ef4444",
  },
  {
    key: "greenLED",
    label: "Green LED",
    description: "Status indicator - typically shows power/ready",
    color: "#22c55e",
  },
];

function LEDConfig() {
  const [messageApi, contextHolder] = message.useMessage();
  
  const [config, setConfig] = useState<LEDConfig>({
    whiteLED: true,
    blueLED: true,
    redLED: false,
    greenLED: true,
  });

  const handleToggle = (key: keyof LEDConfig) => {
    return (checked: boolean) => {
      setConfig((prev) => ({
        ...prev,
        [key]: checked,
      }));
    };
  };

  const handleSave = () => {
    // TODO: Implement API call to save LED configuration
    messageApi.success("LED settings saved successfully");
    console.log("LED config:", config);
  };

  return (
    <div className="p-16">
      {contextHolder}
      
      {/* Page Header */}
      <div className="mb-24">
        <div className="flex items-center gap-12 mb-8">
          <BulbOutlined style={{ fontSize: 28, color: '#9be564' }} />
          <h1 className="text-28 font-bold text-platinum m-0">LED Configuration</h1>
        </div>
        <p className="text-14 text-platinum/60 mt-8">
          Control the LED indicators on your camera
        </p>
      </div>

      {/* LED Controls */}
      <div className="mb-24">
        <div className="font-bold text-16 mb-12 text-platinum/70 uppercase tracking-wide">
          LED Controls
        </div>
        <div className="p-20" style={translucentCardStyle}>
          {ledItems.map((item, index) => (
            <div
              key={item.key}
              className={`flex justify-between items-center py-16 ${
                index > 0 ? "border-t border-white/10" : ""
              }`}
            >
              <div className="flex items-center flex-1 min-w-0">
                <div
                  className="w-40 h-40 rounded-full flex items-center justify-center mr-16"
                  style={{
                    backgroundColor: config[item.key]
                      ? `${item.color}30`
                      : "rgba(224, 224, 224, 0.1)",
                    boxShadow: config[item.key]
                      ? `0 0 12px ${item.color}50`
                      : "none",
                    transition: "all 0.3s ease",
                  }}
                >
                  <div
                    className="w-16 h-16 rounded-full"
                    style={{
                      backgroundColor: config[item.key] ? item.color : "#666666",
                      boxShadow: config[item.key]
                        ? `0 0 8px ${item.color}`
                        : "none",
                      transition: "all 0.3s ease",
                    }}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-16 font-medium text-platinum">
                    {item.label}
                  </div>
                  <div className="text-12 text-platinum/50 mt-2">
                    {item.description}
                  </div>
                </div>
              </div>
              <Switch
                checked={config[item.key]}
                onChange={handleToggle(item.key)}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Status Summary */}
      <div className="mb-24">
        <div className="font-bold text-16 mb-12 text-platinum/70 uppercase tracking-wide">
          Status Summary
        </div>
        <div className="p-20" style={translucentCardStyle}>
          <div className="flex flex-wrap gap-12">
            {ledItems.map((item) => (
              <div
                key={item.key}
                className="flex items-center gap-8 px-12 py-8 rounded-lg"
                style={{
                  backgroundColor: config[item.key]
                    ? `${item.color}20`
                    : "rgba(224, 224, 224, 0.1)",
                }}
              >
                <div
                  className="w-8 h-8 rounded-full"
                  style={{
                    backgroundColor: config[item.key] ? item.color : "#666666",
                  }}
                />
                <span
                  className="text-12"
                  style={{
                    color: config[item.key] ? item.color : "#999999",
                  }}
                >
                  {item.label.split(" ")[0]}: {config[item.key] ? "ON" : "OFF"}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Save Button */}
      <div className="mt-32">
        <button
          onClick={handleSave}
          className="w-full py-14 px-24 rounded-lg font-semibold text-16 text-white flex items-center justify-center gap-8 transition-all duration-200 hover:opacity-90"
          style={{
            backgroundColor: '#2328bb',
            boxShadow: '0 4px 12px rgba(35, 40, 187, 0.4)',
          }}
        >
          <SaveOutlined />
          Save LED Settings
        </button>
      </div>
    </div>
  );
}

export default LEDConfig;
