export const DEVELOPMENT_PROVIDER = "DEVELOPMENT_PROVIDER" as const;

export interface WeatherProviderResult {
  readonly condition: "clear" | "rain" | "snow" | "fog" | "wind" | "unknown";
  readonly temperatureC: number;
  readonly source: typeof DEVELOPMENT_PROVIDER;
}

export interface WeatherProvider {
  getWeather(): Promise<WeatherProviderResult>;
}

export interface EmergencySupportProviderResult {
  readonly requestId: string;
  readonly status: "requested";
  readonly source: typeof DEVELOPMENT_PROVIDER;
}

export interface EmergencySupportProvider {
  requestEmergencySupport(reason: string): Promise<EmergencySupportProviderResult>;
}

export class DevelopmentWeatherProvider implements WeatherProvider {
  readonly #result: WeatherProviderResult;

  constructor(
    result: Omit<WeatherProviderResult, "source"> = { condition: "clear", temperatureC: 25 },
  ) {
    this.#result = Object.freeze({ ...result, source: DEVELOPMENT_PROVIDER });
  }

  getWeather(): Promise<WeatherProviderResult> {
    return Promise.resolve(structuredClone(this.#result));
  }
}

export class DevelopmentEmergencySupportProvider implements EmergencySupportProvider {
  readonly #prefix: string;
  #sequence = 0;

  constructor(prefix = "development-emergency") {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(prefix)) {
      throw new TypeError("Development emergency provider prefix is invalid");
    }
    this.#prefix = prefix;
  }

  requestEmergencySupport(reason: string): Promise<EmergencySupportProviderResult> {
    void reason;
    this.#sequence += 1;
    return Promise.resolve({
      requestId: `${this.#prefix}:${this.#sequence.toString().padStart(6, "0")}`,
      status: "requested",
      source: DEVELOPMENT_PROVIDER,
    });
  }
}
