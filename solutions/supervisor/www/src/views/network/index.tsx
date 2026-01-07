import { Button, Form, Switch, Input, Modal, Empty } from "antd";
import { LoadingOutlined, InfoCircleOutlined, ReloadOutlined, WifiOutlined, GlobalOutlined } from "@ant-design/icons";
import WarnImg from "@/assets/images/warn.png";
import LockImg from "@/assets/images/svg/lock.svg";
import ConnectedImg from "@/assets/images/svg/connected.svg";
import WireImg from "@/assets/images/svg/wire.svg";
import Wifi1 from "@/assets/images/svg/wifi_1.svg";
import Wifi2 from "@/assets/images/svg/wifi_2.svg";
import Wifi3 from "@/assets/images/svg/wifi_3.svg";
import Wifi4 from "@/assets/images/svg/wifi_4.svg";
import { useData, OperateType, FormType } from "./hook";

import {
  WifiAuth,
  NetworkStatus,
  WifiIpAssignmentRule,
  WifiEnable,
} from "@/enum/network";
import { requiredTrimValidate } from "@/utils/validate";

const wifiImg: {
  [prop: number]: string;
} = {
  1: Wifi1,
  2: Wifi2,
  3: Wifi3,
  4: Wifi4,
};

// Convert signal strength value to icon index
const getSignalIcon = (signal: number): number => {
  // Signal strength is negative, larger values (closer to 0) are stronger
  if (signal >= -50) return 4; // Very strong signal
  if (signal >= -60) return 3; // Strong signal
  if (signal >= -70) return 2; // Medium signal
  if (signal >= -80) return 1; // Weak signal
  return 1; // Very weak signal
};

const titleObj = {
  [FormType.Password]: "Password",
  [FormType.Disabled]: "Disable Wi-Fi",
};

// Translucent card style (matching TPR.css .translucent-card-grey-1)
const translucentCardStyle = {
  backgroundColor: 'rgba(31, 31, 27, 0.85)',
  boxShadow: '2px 2px 4px 4px rgba(3, 68, 255, 0.4), -2px -2px 4px 4px rgba(3, 68, 255, 0.2)',
  borderRadius: '12px',
};

// Modal styles (matching TPR.css .translucent-card-grey-1)
const modalContentStyle = {
  backgroundColor: 'rgba(31, 31, 27, 0.95)',
  boxShadow: '2px 2px 4px 4px rgba(3, 68, 255, 0.4), -2px -2px 4px 4px rgba(3, 68, 255, 0.2)',
};

const modalStyles = {
  content: modalContentStyle,
  header: {
    backgroundColor: 'transparent',
    borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
  },
  body: {
    backgroundColor: 'transparent',
  },
  footer: {
    backgroundColor: 'transparent',
    borderTop: '1px solid rgba(255, 255, 255, 0.1)',
  },
};

function Network() {
  const {
    state,
    passwordFormRef,
    setStates,
    onSwitchEnabledWifi,
    toggleVisible,
    onConnect,
    onHandleOperate,
    onClickWifiItem,
    onClickWifiInfo,
    onClickEthernetItem,
    handleSwitchWifi,
    onRefreshNetworks,
  } = useData();

  return (
    <div className="p-16">
      {/* Page Header */}
      <div className="mb-24">
        <div className="flex items-center gap-12 mb-8">
          <GlobalOutlined style={{ fontSize: 28, color: '#9be564' }} />
          <h1 className="text-28 font-bold text-platinum m-0">Network</h1>
        </div>
        {!state.wifiChecked &&
          state.etherStatus === NetworkStatus.Disconnected && (
            <div className="flex items-center mt-12 px-16 py-12 rounded-lg" style={{ backgroundColor: 'rgba(255, 77, 79, 0.2)' }}>
              <img className="w-20" src={WarnImg} alt="" />
              <span className="ml-12 text-14 text-red-400">
                Not connected to any network
              </span>
            </div>
          )}
      </div>

      {/* Ethernet Section */}
      <div className="mb-24">
        <div className="font-bold text-16 mb-12 text-platinum/70 uppercase tracking-wide">Ethernet</div>
        <div className="p-20" style={translucentCardStyle}>
          {state.etherInfo ? (
            <div
              className="flex justify-between items-center cursor-pointer"
              onClick={onClickEthernetItem}
            >
              <div className="flex items-center flex-1 min-w-0">
                <div className="w-40 h-40 rounded-full flex items-center justify-center mr-16" style={{ backgroundColor: 'rgba(155, 229, 100, 0.2)' }}>
                  <img className="w-20 invert" src={WireImg} alt="" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center">
                    <span className="text-16 font-medium text-platinum truncate">Ethernet</span>
                    {state.etherStatus === NetworkStatus.Connected && (
                      <span className="ml-8 px-8 py-2 text-10 rounded-full bg-cta/20 text-cta">Connected</span>
                    )}
                  </div>
                  <div className="text-12 text-platinum/50 mt-2">
                    {state.etherStatus === NetworkStatus.Connected ? 'Wired connection active' : 'Cable not connected'}
                  </div>
                </div>
              </div>
              <Button
                type="text"
                size="small"
                icon={<InfoCircleOutlined style={{ color: '#e0e0e0', fontSize: 18 }} />}
                onClick={(event) => {
                  event.stopPropagation();
                  onClickEthernetItem();
                }}
              />
            </div>
          ) : (
            <div className="flex items-center justify-center py-8">
              <div className="text-center">
                <div className="w-48 h-48 rounded-full flex items-center justify-center mx-auto mb-12" style={{ backgroundColor: 'rgba(224, 224, 224, 0.1)' }}>
                  <img className="w-24 opacity-40 invert" src={WireImg} alt="" />
                </div>
                <div className="text-14 text-platinum/50">No Ethernet adapter detected</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Wi-Fi Section */}
      {state.wifiEnable !== WifiEnable.Disable && (
        <div className="mb-24">
          <div className="font-bold text-16 mb-12 text-platinum/70 uppercase tracking-wide">Wi-Fi</div>
          
          {/* Wi-Fi Enable Toggle Card */}
          <div className="p-20 mb-16" style={translucentCardStyle}>
            <div className="flex justify-between items-center">
              <div className="flex items-center">
                <div className="w-40 h-40 rounded-full flex items-center justify-center mr-16" style={{ backgroundColor: state.wifiChecked ? 'rgba(35, 40, 187, 0.3)' : 'rgba(224, 224, 224, 0.1)' }}>
                  <WifiOutlined style={{ fontSize: 20, color: state.wifiChecked ? '#9be564' : '#e0e0e0' }} />
                </div>
                <div>
                  <div className="text-16 font-medium text-platinum">Wi-Fi</div>
                  <div className="text-12 text-platinum/50 mt-2">
                    {state.wifiChecked ? 'Wireless networking enabled' : 'Wireless networking disabled'}
                  </div>
                </div>
              </div>
              <Switch
                checked={state.wifiChecked}
                onChange={onSwitchEnabledWifi}
              />
            </div>
          </div>

          {/* Connected Networks */}
          {state.wifiChecked && state.connectedWifiInfoList.length > 0 && (
            <div className="mb-16">
              <div className="text-12 text-platinum/50 uppercase tracking-wide mb-8 px-4">My Networks</div>
              <div className="p-16" style={translucentCardStyle}>
                {state.connectedWifiInfoList.map((wifiItem, index) => (
                  <div
                    className={`flex justify-between items-center py-12 cursor-pointer ${index > 0 ? 'border-t border-white/10' : ''}`}
                    key={index}
                    onClick={() => onClickWifiItem(wifiItem)}
                  >
                    <div className="flex items-center flex-1 min-w-0">
                      <div className="w-32 h-32 rounded-full flex items-center justify-center mr-12" style={{ backgroundColor: 'rgba(35, 40, 187, 0.3)' }}>
                        {wifiItem.status === NetworkStatus.Connecting ? (
                          <LoadingOutlined style={{ color: '#9be564', fontSize: 16 }} />
                        ) : (
                          <img className="w-16 invert" src={wifiImg[getSignalIcon(wifiItem.signal)]} alt="" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center">
                          <span className="text-15 font-medium text-platinum truncate">{wifiItem.ssid}</span>
                          {wifiItem.status === NetworkStatus.Connected && (
                            <img className="w-14 ml-8 invert" src={ConnectedImg} alt="" />
                          )}
                        </div>
                        <div className="text-11 text-platinum/50 mt-1">
                          {wifiItem.status === NetworkStatus.Connected ? 'Connected' : 
                           wifiItem.status === NetworkStatus.Connecting ? 'Connecting...' : 'Saved'}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-8">
                      {wifiItem.auth === WifiAuth.Need && (
                        <img className="w-14 opacity-60 invert" src={LockImg} alt="" />
                      )}
                      <Button
                        type="text"
                        size="small"
                        icon={<InfoCircleOutlined style={{ color: '#e0e0e0', fontSize: 16 }} />}
                        onClick={(event) => {
                          event.stopPropagation();
                          onClickWifiInfo(wifiItem);
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Available Networks */}
          {state.wifiChecked && (
            <div>
              <div className="flex justify-between items-center mb-8 px-4">
                <div className="text-12 text-platinum/50 uppercase tracking-wide">Available Networks</div>
                <Button
                  type="text"
                  size="small"
                  icon={
                    state.refreshLoading ? 
                      <LoadingOutlined style={{ color: '#9be564', fontSize: 14 }} /> : 
                      <ReloadOutlined style={{ color: '#e0e0e0', fontSize: 14 }} />
                  }
                  onClick={onRefreshNetworks}
                  disabled={state.refreshLoading}
                >
                  <span className="text-12 text-platinum/60">Refresh</span>
                </Button>
              </div>
              <div className="p-16" style={translucentCardStyle}>
                {state.wifiInfoList.length > 0 ? (
                  state.wifiInfoList.map((wifiItem, index) => (
                    <div
                      className={`flex justify-between items-center py-12 cursor-pointer hover:bg-white/5 -mx-8 px-8 rounded-lg transition-colors ${index > 0 ? 'border-t border-white/10 mt-2 pt-14' : ''}`}
                      key={index}
                      onClick={() => onClickWifiItem(wifiItem)}
                    >
                      <div className="flex items-center flex-1 min-w-0">
                        <div className="w-32 h-32 rounded-full flex items-center justify-center mr-12" style={{ backgroundColor: 'rgba(224, 224, 224, 0.1)' }}>
                          {wifiItem.status === NetworkStatus.Connecting ? (
                            <LoadingOutlined style={{ color: '#9be564', fontSize: 16 }} />
                          ) : (
                            <img className="w-16 invert" src={wifiImg[getSignalIcon(wifiItem.signal)]} alt="" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-15 text-platinum truncate block">{wifiItem.ssid}</span>
                          <div className="text-11 text-platinum/40 mt-1">
                            {wifiItem.auth === WifiAuth.Need ? 'Secured' : 'Open'}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-8">
                        {wifiItem.auth === WifiAuth.Need && (
                          <img className="w-14 opacity-40 invert" src={LockImg} alt="" />
                        )}
                        <Button
                          type="text"
                          size="small"
                          icon={<InfoCircleOutlined style={{ color: '#e0e0e0', fontSize: 16 }} />}
                          onClick={(event) => {
                            event.stopPropagation();
                            onClickWifiInfo(wifiItem);
                          }}
                        />
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="py-16">
                    <Empty 
                      description={
                        <span className="text-platinum/50">
                          {state.refreshLoading ? 'Scanning for networks...' : 'No networks found'}
                        </span>
                      }
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      
      {/* Password / Disable WiFi Modal */}
      <Modal
        open={state.visible}
        onCancel={toggleVisible}
        footer={null}
        centered
        width="90%"
        style={{ maxWidth: 480 }}
        title={<span className="text-platinum">{titleObj[state.formType]}</span>}
        destroyOnClose
        styles={modalStyles}
      >
        {state.formType === FormType.Disabled && (
          <div>
            <div className="text-platinum/80 text-16 mb-20">
              This action will prevent you from access this web dashboard. Are
              you sure want to turn off it now?
            </div>
            <Button
              block
              danger
              type="primary"
              loading={state.submitLoading}
              onClick={handleSwitchWifi}
            >
              Confirm
            </Button>
          </div>
        )}
        {state.formType === FormType.Password && (
          <Form
            ref={passwordFormRef}
            className="border-b-0"
            requiredMark={false}
            onFinish={onConnect}
            initialValues={{
              password: state.password,
            }}
          >
            <Form.Item
              name="password"
              label=""
              rules={[requiredTrimValidate()]}
            >
              <Input.Password 
                placeholder="Enter Wi-Fi password" 
                allowClear 
                maxLength={63}
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.1)',
                  borderColor: 'rgba(224, 224, 224, 0.3)',
                  color: '#e0e0e0',
                }}
              />
            </Form.Item>
            <Button
              block
              type="primary"
              htmlType="submit"
              loading={state.submitLoading}
            >
              Connect
            </Button>
          </Form>
        )}
      </Modal>
      
      {/* WiFi/Ethernet Info Modal */}
      <Modal
        open={state.wifiVisible}
        onCancel={() => {
          setStates({
            wifiVisible: false,
          });
        }}
        footer={null}
        centered
        width="90%"
        style={{ maxWidth: 480 }}
        closable
        destroyOnClose
        title={<span className="text-platinum">{state.selectedWifiInfo?.ssid || 'Ethernet'}</span>}
        styles={modalStyles}
      >
        <div className="pr-6">
          <div className="pr-14 h-full overflow-y-auto flex-1 flex flex-col justify-between">
            {state.selectedWifiInfo && state.selectedWifiInfo?.ssid && (
              <div className="flex mb-20 gap-12">
                {state.selectedWifiInfo?.status === NetworkStatus.Connected ? (
                  <>
                    <Button
                      size="small"
                      color="danger"
                      variant="solid"
                      block
                      loading={
                        state.submitLoading &&
                        state.submitType == OperateType.Forget
                      }
                      onClick={() => onHandleOperate(OperateType.Forget)}
                    >
                      Forget
                    </Button>
                    <Button
                      size="small"
                      type="primary"
                      block
                      loading={
                        state.submitLoading &&
                        state.submitType == OperateType.DisConnect
                      }
                      onClick={() => onHandleOperate(OperateType.DisConnect)}
                    >
                      Disconnect
                    </Button>
                  </>
                ) : (state.connectedWifiInfoList || []).some(
                    (item) => item.ssid === state.selectedWifiInfo?.ssid
                  ) ? (
                  <>
                    <Button
                      size="small"
                      color="danger"
                      variant="solid"
                      block
                      loading={
                        state.submitLoading &&
                        state.submitType == OperateType.Forget
                      }
                      onClick={() => onHandleOperate(OperateType.Forget)}
                    >
                      Forget
                    </Button>
                    <Button
                      size="small"
                      type="primary"
                      block
                      loading={
                        state.submitLoading &&
                        state.submitType == OperateType.Connect
                      }
                      onClick={() => onHandleOperate(OperateType.Connect)}
                    >
                      Connect
                    </Button>
                  </>
                ) : (
                  <Button
                    size="small"
                    type="primary"
                    block
                    loading={
                      state.submitLoading &&
                      state.submitType == OperateType.Connect
                    }
                    onClick={() => onHandleOperate(OperateType.Connect)}
                  >
                    <span className="text-14">Connect</span>
                  </Button>
                )}
              </div>
            )}

            <div className="flex-1 border-t border-white/10 pt-16">
              <div className="mb-16">
                <div className="text-12 text-platinum/50 uppercase tracking-wide mb-8">Connection Details</div>
                <div className="flex justify-between py-8 border-b border-white/10">
                  <span className="text-14 text-platinum/70">MAC Address</span>
                  <span className="text-14 text-platinum font-mono">
                    {state.selectedWifiInfo?.macAddress || "N/A"}
                  </span>
                </div>
              </div>

              {state.selectedWifiInfo && (
                <div>
                  <div className="text-12 text-platinum/50 uppercase tracking-wide mb-8">IPv4 Configuration</div>
                  <div className="flex justify-between py-8 border-b border-white/10">
                    <span className="text-14 text-platinum/70">IP Assignment</span>
                    <span className="text-14 text-platinum">
                      {state.selectedWifiInfo?.ipAssignment ===
                      WifiIpAssignmentRule.Automatic
                        ? "Automatic (DHCP)"
                        : "Static"}
                    </span>
                  </div>
                  <div className="flex justify-between py-8 border-b border-white/10">
                    <span className="text-14 text-platinum/70">IP Address</span>
                    <span className="text-14 text-platinum font-mono">
                      {state.selectedWifiInfo?.ip || "N/A"}
                    </span>
                  </div>
                  <div className="flex justify-between py-8 border-b border-white/10">
                    <span className="text-14 text-platinum/70">Subnet Mask</span>
                    <span className="text-14 text-platinum font-mono">
                      {state.selectedWifiInfo?.subnetMask || "N/A"}
                    </span>
                  </div>
                  <div className="flex justify-between py-8 border-b border-white/10">
                    <span className="text-14 text-platinum/70">Primary DNS</span>
                    <span className="text-14 text-platinum font-mono">
                      {state.selectedWifiInfo?.dns1 || "N/A"}
                    </span>
                  </div>
                  <div className="flex justify-between py-8">
                    <span className="text-14 text-platinum/70">Secondary DNS</span>
                    <span className="text-14 text-platinum font-mono">
                      {state.selectedWifiInfo?.dns2 || "N/A"}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default Network;
