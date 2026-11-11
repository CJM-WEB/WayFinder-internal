/// <reference types="vite/client" />
/** 公开构建配置只用于备案显示；服务端秘密不得声明或读取为VITE变量。 */
interface ImportMetaEnv {
  readonly VITE_ICP_FILING?: string;
}
