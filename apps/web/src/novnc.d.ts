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
    /** Show a dot when the remote cursor is empty/hidden (e.g. macOS Screen Sharing). */
    showDotCursor: boolean;
    focus(): void;
    blur(): void;
    disconnect(): void;
    sendCtrlAltDel(): void;
    sendCredentials(credentials: { username?: string; password?: string; target?: string }): void;
    machineReboot(): void;
  }
}
