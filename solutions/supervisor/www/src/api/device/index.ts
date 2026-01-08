import { supervisorRequest } from "@/utils/request";
import { PowerMode, DeviceChannleMode, SystemUpdateStatus } from "@/enum";
import {
  IDeviceInfo,
  IChannelParams,
  IServiceStatus,
  IIPDevice,
} from "./device";

// 获取设备信息
export const queryDeviceInfoApi = async () =>
  supervisorRequest<IDeviceInfo>(
    {
      url: "api/deviceMgr/queryDeviceInfo",
      method: "get",
    },
    {
      catchs: true,
    }
  );

export const getDeviceListApi = async () =>
  supervisorRequest<{
    deviceList: IIPDevice[];
  }>(
    {
      url: "api/deviceMgr/getDeviceList",
      method: "get",
    },
    {
      catchs: true,
    }
  );

// 获取设备运行状态
export const queryServiceStatusApi = async () =>
  supervisorRequest<IServiceStatus>(
    {
      url: "api/deviceMgr/queryServiceStatus",
      method: "get",
      timeout: 5000,
    },
    {
      catchs: true,
    }
  );

// 修改设备信息
export const updateDeviceInfoApi = async (data: { deviceName: string }) =>
  supervisorRequest<IDeviceInfo>({
    url: "api/deviceMgr/updateDeviceName",
    method: "post",
    data,
  });

// 修改渠道信息
export const changeChannleApi = async (data: IChannelParams) =>
  supervisorRequest({
    url: "api/deviceMgr/updateChannel",
    method: "post",
    data,
  });
// 设备重启与关机
export const setDevicePowerApi = async (data: { mode: PowerMode }) =>
  supervisorRequest({
    url: "api/deviceMgr/setPower",
    method: "post",
    data,
  });
// 更新设备系统
export const updateSystemApi = async () =>
  supervisorRequest({
    url: "api/deviceMgr/updateSystem",
    method: "post",
  });
// 获取设备更新进度
export const getUpdateSystemProgressApi = async () =>
  supervisorRequest<{
    progress: number;
  }>({
    url: "api/deviceMgr/getUpdateProgress",
    method: "get",
  });
// 更新设备系统
export const cancelUpdateApi = async () =>
  supervisorRequest({
    url: "api/deviceMgr/cancelUpdate",
    method: "post",
  });

// 获取设备更新版本信息
export const getSystemUpdateVesionInfoApi = async (data: {
  url: string;
  channel?: DeviceChannleMode;
}) =>
  supervisorRequest<{
    osName: string;
    osVersion: string;
    status: SystemUpdateStatus;
  }>(
    {
      url: "api/deviceMgr/getSystemUpdateVersion",
      method: "post",
      data,
    },
    {
      catchs: true,
    }
  );

// 获取模型信息
export const getModelInfoApi = async () =>
  supervisorRequest<IDeviceInfo>(
    {
      url: "api/deviceMgr/getModelInfo",
      method: "get",
    },
    {
      catchs: true,
    }
  );

export const uploadModelApi = async (data: FormData) =>
  supervisorRequest<IDeviceInfo>({
    url: "api/deviceMgr/uploadModel",
    method: "post",
    data,
  });

// 保存平台信息
export const savePlatformInfoApi = async (data: { platform_info: string }) =>
  supervisorRequest({
    url: "api/deviceMgr/savePlatformInfo",
    method: "post",
    data,
  });

// 获取平台信息
export const getPlatformInfoApi = async () =>
  supervisorRequest<{
    platform_info: string;
  }>(
    {
      url: "api/deviceMgr/getPlatformInfo",
      method: "get",
    },
    {
      catchs: true,
    }
  );

// Factory reset - sets the factory reset flag
export const factoryResetApi = async () =>
  supervisorRequest<{
    status: string;
    message: string;
  }>({
    url: "api/deviceMgr/factoryReset",
    method: "post",
  });

// Format SD card - formats the SD card with ext4
export const formatSDCardApi = async () =>
  supervisorRequest<{
    status: string;
    message: string;
  }>({
    url: "api/deviceMgr/formatSDCard",
    method: "post",
  });

// Analytics configuration
export const getAnalyticsConfigApi = async () =>
  supervisorRequest<{
    enabled: boolean;
  }>({
    url: "api/deviceMgr/getAnalyticsConfig",
    method: "get",
  });

export const setAnalyticsConfigApi = async (data: { enabled: boolean }) =>
  supervisorRequest<{
    status: string;
    message: string;
    enabled: boolean;
  }>({
    url: "api/deviceMgr/setAnalyticsConfig",
    method: "post",
    data,
  });

// Camera re-registration
export const reRegisterCameraApi = async () =>
  supervisorRequest<{
    status: string;
    message: string;
  }>({
    url: "api/deviceMgr/reRegisterCamera",
    method: "post",
  });

// Update configuration
export interface UpdateConfig {
  os_source: "tpr_official" | "self_hosted";
  model_source: "tpr_official" | "self_hosted";
  self_hosted_os_url: string;
  self_hosted_model_url: string;
  check_frequency: "30min" | "daily" | "weekly" | "manual";
  weekly_day: "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";
}

export const getUpdateConfigApi = async () =>
  supervisorRequest<UpdateConfig>({
    url: "api/updateMgr/getConfig",
    method: "get",
  });

export const setUpdateConfigApi = async (data: UpdateConfig) =>
  supervisorRequest<{
    status: string;
    message: string;
  }>({
    url: "api/updateMgr/setConfig",
    method: "post",
    data,
  });
