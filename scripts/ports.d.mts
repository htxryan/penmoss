// Types for scripts/ports.mjs, which the Playwright and Vite configs import.
export type PortName = 'vite' | 'preview' | 'worker' | 'fakeGithub' | 'inspector';
export type Ports = Readonly<Record<PortName, number>>;
export declare const BASE_PORTS: Ports;
export declare const OFFSETS: Ports;
export declare const MAX_BLOCK: number;
export declare function parseBlock(value: string | undefined): number;
export declare function portsFor(block: number): Ports;
export declare function ports(env?: Readonly<Record<string, string | undefined>>): Ports;
