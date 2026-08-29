declare module '@novnc/novnc' {
  interface RFBOptions {
    credentials?: { username?: string; password?: string; target?: string };
    shared?: boolean;
    repeaterID?: string;
    wsProtocols?: string[];
  }
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RFBOptions);
    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    focus(): void;
    blur(): void;
    disconnect(): void;
    sendCtrlAltDel(): void;
    machineReboot(): void;
  }
}
