declare module 'guacamole-common-js' {
  export interface MouseState {
    x: number;
    y: number;
  }
  export class Mouse {
    constructor(element: HTMLElement);
    currentState: MouseState;
    onmousedown: ((state: MouseState) => void) | null;
    onmouseup: ((state: MouseState) => void) | null;
    onmousemove: ((state: MouseState) => void) | null;
  }
  export class Keyboard {
    constructor(element: HTMLElement | Document);
    onkeydown: ((keysym: number) => boolean | void) | null;
    onkeyup: ((keysym: number) => void) | null;
    reset(): void;
  }
  export class Display {
    getElement(): HTMLElement;
    scale(scale: number): void;
    getWidth(): number;
    getHeight(): number;
  }
  export class Status {
    code: number;
    message?: string;
  }
  export interface Tunnel {
    // opaque
    readonly _tunnel?: never;
  }
  export class WebSocketTunnel implements Tunnel {
    constructor(url: string);
  }
  export class Client {
    constructor(tunnel: Tunnel);
    getDisplay(): Display;
    connect(data?: string): void;
    disconnect(): void;
    sendMouseState(state: MouseState): void;
    sendKeyEvent(pressed: number, keysym: number): void;
    sendSize(width: number, height: number): void;
    onstatechange: ((state: number) => void) | null;
    onerror: ((status: Status) => void) | null;
    onname: ((name: string) => void) | null;
  }

  const Guacamole: {
    Client: typeof Client;
    Mouse: typeof Mouse;
    Keyboard: typeof Keyboard;
    Display: typeof Display;
    Status: typeof Status;
    WebSocketTunnel: typeof WebSocketTunnel;
  };
  export default Guacamole;
}
