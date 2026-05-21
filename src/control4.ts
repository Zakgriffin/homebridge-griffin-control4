import axios, { AxiosInstance } from "axios";
import https from "https";

const APPLICATION_KEY = "78f6791373d61bea49fdb9fb8897f1f3af193f11";
const CLOUD_AUTH = "https://apis.control4.com/authentication/v1/rest";
const CLOUD_ACCOUNTS = "https://apis.control4.com/account/v3/rest/accounts";
const CLOUD_DIRECTOR_AUTH = "https://apis.control4.com/authentication/v1/rest/authorization";

export interface C4Item {
  id: number;
  type: number;
  name: string;
  proxy: string;
  proxyOrder?: number;
  roomName?: string;
  URIs: {
    variables?: string;
    commands?: string;
  };
}

async function cloudPost(url: string, body: unknown, token?: string): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function cloudGet(url: string, token: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

export class Control4 {
  private readonly localClient: AxiosInstance;

  private accountToken = "";
  private directorToken = "";
  private directorTokenExpiry = 0;
  private controllerCommonName = "";

  constructor(
    private readonly host: string,
    private readonly username: string,
    private readonly password: string,
  ) {
    this.localClient = axios.create({
      baseURL: `https://${host}`,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
  }

  async initialize(): Promise<void> {
    const authRes = await cloudPost(CLOUD_AUTH, {
      clientInfo: {
        device: { deviceName: "homebridge", deviceUUID: "0000000000000000", make: "homebridge", model: "homebridge", os: "Android", osVersion: "10" },
        userInfo: { applicationKey: APPLICATION_KEY, password: this.password, userName: this.username },
      },
    }) as { authToken: { token: string } };
    this.accountToken = authRes.authToken.token;

    const accountsRes = await cloudGet(CLOUD_ACCOUNTS, this.accountToken) as { account: { controllerCommonName: string } };
    this.controllerCommonName = accountsRes.account.controllerCommonName;

    await this.refreshDirectorToken();
  }

  private async refreshDirectorToken(): Promise<void> {
    const res = await cloudPost(
      CLOUD_DIRECTOR_AUTH,
      { serviceInfo: { commonName: this.controllerCommonName, services: "director" } },
      this.accountToken,
    ) as { authToken: { token: string; validSeconds: number } };
    this.directorToken = res.authToken.token;
    const validSeconds = res.authToken.validSeconds;
    this.directorTokenExpiry = Date.now() + (validSeconds > 0 ? validSeconds - 300 : 86100) * 1000;
  }

  private async ensureAuth(): Promise<void> {
    if (Date.now() >= this.directorTokenExpiry) {
      await this.refreshDirectorToken();
    }
  }

  private get authHeader() {
    return { Authorization: `Bearer ${this.directorToken}` };
  }

  async getItems(): Promise<C4Item[]> {
    await this.ensureAuth();
    const res = await this.localClient.get<C4Item[]>("/api/v1/items", { headers: this.authHeader });
    return res.data;
  }

  async getVariable(itemId: number, varName: string): Promise<string> {
    await this.ensureAuth();
    const res = await this.localClient.get(`/api/v1/items/${itemId}/variables`, {
      headers: this.authHeader,
      params: { varnames: varName },
    });
    const data = res.data;
    const entry = Array.isArray(data)
      ? data.find((v: { varName: string }) => v.varName === varName)
      : data?.varName === varName ? data : undefined;
    const value = entry?.value;
    return value !== undefined && value !== "Undefined" ? String(value) : "";
  }

  async getVariables(itemId: number): Promise<Array<{ varName: string; value: unknown }>> {
    await this.ensureAuth();
    const res = await this.localClient.get(`/api/v1/items/${itemId}/variables`, { headers: this.authHeader });
    const data = res.data;
    return Array.isArray(data) ? data : data ? [data] : [];
  }

  async sendCommand(itemId: number, command: string, params: Record<string, string | number> = {}): Promise<void> {
    await this.ensureAuth();
    await this.localClient.post(
      `/api/v1/items/${itemId}/commands`,
      { async: false, command, tParams: params },
      { headers: this.authHeader },
    );
  }
}
