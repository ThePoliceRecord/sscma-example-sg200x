import CommonPopup from "@/components/common-popup";
import { Button, Form, Input, Switch, Empty } from "antd";
import KeyImg from "@/assets/images/svg/key.svg";
import { DeleteOutlined, UserOutlined, LockOutlined, SafetyCertificateOutlined, KeyOutlined, PlusOutlined } from "@ant-design/icons";
import { useData, IFormTypeEnum } from "./hook";
import moment from "moment";
import {
  requiredTrimValidate,
  publicKeyValidate,
  passwordRules,
} from "@/utils/validate";

const titleObj = {
  [IFormTypeEnum.Key]: "Add new SSH Key",
  [IFormTypeEnum.Username]: "Edit Username",
  [IFormTypeEnum.Password]: "Confirm Password",
  [IFormTypeEnum.DelKey]: "Remove SSH Key",
};

// Translucent card style (matching TPR.css .translucent-card-grey-1)
const translucentCardStyle = {
  backgroundColor: 'rgba(31, 31, 27, 0.85)',
  boxShadow: '2px 2px 4px 4px rgba(3, 68, 255, 0.4), -2px -2px 4px 4px rgba(3, 68, 255, 0.2)',
  borderRadius: '12px',
};

const Security = () => {
  const {
    state,
    formRef,
    passwordFormRef,
    usernameFormRef,
    onCancel,
    onEdit,
    addSshKey,
    onPasswordFinish,
    onUsernameFinish,
    onDelete,
    onAddSshFinish,
    onDeleteFinish,
    setSShStatus,
  } = useData();

  const handleSShStatusChange = (checked: boolean) => {
    setSShStatus(checked);
  };

  return (
    <div className="p-16">
      {/* Page Header */}
      <div className="mb-24">
        <div className="flex items-center gap-12 mb-8">
          <SafetyCertificateOutlined style={{ fontSize: 28, color: '#9be564' }} />
          <h1 className="text-28 font-bold text-platinum m-0">Security</h1>
        </div>
        <p className="text-14 text-platinum/60 mt-8">
          Manage your account credentials and SSH access
        </p>
      </div>

      {/* User Account Section */}
      <div className="mb-24">
        <div className="font-bold text-16 mb-12 text-platinum/70 uppercase tracking-wide">Account</div>
        <div className="p-20" style={translucentCardStyle}>
          {/* Username Row */}
          <div className="flex items-center justify-between pb-16 border-b border-white/10">
            <div className="flex items-center">
              <div className="w-40 h-40 rounded-full flex items-center justify-center mr-16" style={{ backgroundColor: 'rgba(35, 40, 187, 0.3)' }}>
                <UserOutlined style={{ fontSize: 18, color: '#9be564' }} />
              </div>
              <div>
                <div className="text-12 text-platinum/50 uppercase tracking-wide">Username</div>
                <div className="text-16 font-medium text-platinum mt-2">{state.username}</div>
              </div>
            </div>
          </div>
          
          {/* Password Row */}
          <div className="flex items-center justify-between pt-16">
            <div className="flex items-center">
              <div className="w-40 h-40 rounded-full flex items-center justify-center mr-16" style={{ backgroundColor: 'rgba(35, 40, 187, 0.3)' }}>
                <LockOutlined style={{ fontSize: 18, color: '#9be564' }} />
              </div>
              <div>
                <div className="text-12 text-platinum/50 uppercase tracking-wide">Password</div>
                <div className="text-14 text-platinum/60 mt-2">••••••••</div>
              </div>
            </div>
            <Button
              type="primary"
              onClick={() => onEdit(IFormTypeEnum.Password)}
            >
              Change Password
            </Button>
          </div>
        </div>
      </div>

      {/* SSH Section */}
      <div className="mb-24">
        <div className="font-bold text-16 mb-12 text-platinum/70 uppercase tracking-wide">SSH Access</div>
        
        {/* SSH Enable Toggle Card */}
        <div className="p-20 mb-16" style={translucentCardStyle}>
          <div className="flex justify-between items-center">
            <div className="flex items-center">
              <div className="w-40 h-40 rounded-full flex items-center justify-center mr-16" style={{ backgroundColor: state.sshEnabled ? 'rgba(35, 40, 187, 0.3)' : 'rgba(224, 224, 224, 0.1)' }}>
                <KeyOutlined style={{ fontSize: 18, color: state.sshEnabled ? '#9be564' : '#e0e0e0' }} />
              </div>
              <div>
                <div className="text-16 font-medium text-platinum">SSH Server</div>
                <div className="text-12 text-platinum/50 mt-2">
                  {state.sshEnabled ? 'Remote access enabled' : 'Remote access disabled'}
                </div>
              </div>
            </div>
            <Switch checked={state.sshEnabled} onChange={handleSShStatusChange} />
          </div>
        </div>

        {/* SSH Keys List */}
        {state.sshEnabled && (
          <div className="p-20" style={translucentCardStyle}>
            <div className="flex justify-between items-center mb-16">
              <div className="text-14 text-platinum/70">Authorized Keys</div>
              <Button 
                type="primary" 
                size="small" 
                icon={<PlusOutlined />}
                onClick={addSshKey}
              >
                Add Key
              </Button>
            </div>
            
            {state.sshkeyList?.length ? (
              <div className="space-y-12">
                {state.sshkeyList.map((item, index) => (
                  <div
                    className="rounded-12 p-16 border border-white/10 hover:border-primary/30 transition-colors"
                    style={{ backgroundColor: 'rgba(255, 255, 255, 0.03)' }}
                    key={item.id || index}
                  >
                    <div className="flex items-start">
                      <div className="w-44 h-44 rounded-lg flex items-center justify-center mr-16 flex-shrink-0" style={{ backgroundColor: 'rgba(35, 40, 187, 0.2)' }}>
                        <img className="w-24 h-24 invert opacity-80" src={KeyImg} alt="" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start">
                          <div>
                            <div className="text-16 font-medium text-platinum">{item.name}</div>
                            <div className="inline-block mt-4 px-8 py-2 rounded text-10 uppercase tracking-wide" style={{ backgroundColor: 'rgba(35, 40, 187, 0.3)', color: '#9be564' }}>
                              SSH Key
                            </div>
                          </div>
                          <Button
                            type="text"
                            danger
                            size="small"
                            icon={<DeleteOutlined />}
                            onClick={() => onDelete(item)}
                          >
                            Remove
                          </Button>
                        </div>
                        <div className="text-12 text-platinum/40 mt-12 font-mono break-all line-clamp-2">
                          {item.value}
                        </div>
                        <div className="text-11 text-platinum/40 mt-8">
                          Added {item.addTime && moment(item.addTime).format("MMMM DD, YYYY")}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-16">
                <Empty 
                  description={
                    <div className="text-center">
                      <div className="text-platinum/50 mb-8">No SSH keys configured</div>
                      <div className="text-12 text-platinum/40">Add a public key to enable secure remote access</div>
                    </div>
                  }
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modals */}
      <CommonPopup
        visible={state.visible}
        title={titleObj[state.formType]}
        onCancel={onCancel}
      >
        {state.formType == IFormTypeEnum.Key && (
          <Form
            form={formRef}
            className="border-b-0"
            onFinish={onAddSshFinish}
            layout="vertical"
          >
            <Form.Item
              name="sshName"
              label={<span className="text-platinum">Key Name</span>}
              rules={[requiredTrimValidate()]}
            >
              <Input 
                placeholder="e.g., My MacBook Pro" 
                allowClear 
                maxLength={32}
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.1)',
                  borderColor: 'rgba(224, 224, 224, 0.3)',
                  color: '#e0e0e0',
                }}
              />
            </Form.Item>
            <Form.Item
              name="sshKey"
              label={<span className="text-platinum">Public Key</span>}
              trigger="onChange"
              rules={[publicKeyValidate()]}
              extra={<span className="text-platinum/40 text-12">Begins with 'ssh-rsa', 'ssh-ed25519', or 'ssh-dss'</span>}
            >
              <Input.TextArea
                rows={6}
                placeholder="Paste your public key here..."
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.1)',
                  borderColor: 'rgba(224, 224, 224, 0.3)',
                  color: '#e0e0e0',
                  fontFamily: 'monospace',
                }}
              />
            </Form.Item>
            <Form.Item className="mb-0 mt-24">
              <Button type="primary" block htmlType="submit">
                Add SSH Key
              </Button>
            </Form.Item>
          </Form>
        )}
        {state.formType == IFormTypeEnum.Password && (
          <Form
            form={passwordFormRef}
            className="border-b-0"
            onFinish={onPasswordFinish}
            layout="vertical"
          >
            <Form.Item
              name="oldPassword"
              label={<span className="text-platinum">Current Password</span>}
              rules={[requiredTrimValidate()]}
            >
              <Input.Password 
                placeholder="Enter current password" 
                allowClear 
                maxLength={16}
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.1)',
                  borderColor: 'rgba(224, 224, 224, 0.3)',
                  color: '#e0e0e0',
                }}
              />
            </Form.Item>
            <Form.Item
              name="newPassword"
              label={<span className="text-platinum">New Password</span>}
              rules={passwordRules}
              extra={<span className="text-platinum/40 text-12">Must be at least 8 characters</span>}
            >
              <Input.Password 
                placeholder="Enter new password" 
                allowClear 
                maxLength={16}
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.1)',
                  borderColor: 'rgba(224, 224, 224, 0.3)',
                  color: '#e0e0e0',
                }}
              />
            </Form.Item>
            <Form.Item className="mb-0 mt-24">
              <Button type="primary" block htmlType="submit">
                Update Password
              </Button>
            </Form.Item>
          </Form>
        )}
        {state.formType == IFormTypeEnum.Username && (
          <Form
            form={usernameFormRef}
            onFinish={onUsernameFinish}
            layout="vertical"
            initialValues={{
              username: state.username,
            }}
          >
            <Form.Item
              name="username"
              label={<span className="text-platinum">Username</span>}
              rules={[requiredTrimValidate()]}
            >
              <Input 
                placeholder="Enter username" 
                allowClear 
                maxLength={32}
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.1)',
                  borderColor: 'rgba(224, 224, 224, 0.3)',
                  color: '#e0e0e0',
                }}
              />
            </Form.Item>
            <Form.Item className="mb-0 mt-24">
              <Button type="primary" block htmlType="submit">
                Update Username
              </Button>
            </Form.Item>
          </Form>
        )}
        {state.formType == IFormTypeEnum.DelKey && (
          <div>
            <div className="text-platinum/80 text-16 mb-8">
              Are you sure you want to remove this SSH key?
            </div>
            <div className="text-platinum/50 text-14 mb-24">
              This action cannot be undone. You will need to add the key again to restore access.
            </div>
            <Button type="primary" block danger onClick={onDeleteFinish}>
              Remove Key
            </Button>
          </div>
        )}
      </CommonPopup>
    </div>
  );
};

export default Security;
