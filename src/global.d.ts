/**
 * Ambient module declarations for packages that may not be installed.
 * These stubs allow TypeScript compilation to pass when the packages are
 * unavailable at build time. Real types replace them when the packages
 * are installed at runtime.
 */

declare module '@kilocode/sdk' {
  export function createKilo(options?: {
    port?: number;
    configPath?: string;
  }): Promise<{ client: unknown; server: unknown }>;
  export function createKiloClient(options?: { baseUrl?: string }): unknown;
}
