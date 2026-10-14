declare module 'iqdb-client' {
  export interface IQDBSearchResultItem {
    head: string;
    img: string;
    name?: string;
    sourceUrl?: string;
    source?: string[];
    similarity: number | null;
    type?: string;
  }

  export interface IQDBClientConfig {
    baseDomain: string;
    similarityPass: number;
    userAgent: string;
    fetchOptions?: RequestInit;
  }

  export interface IQDBSearchResponse {
    ok: boolean;
    err?: string;
    data?: IQDBSearchResultItem[];
    service?: number[];
  }

  export interface IQDBSearchOptions {
    lib: 'www';
    fileName?: string;
  }

  export const defaultConfig: IQDBClientConfig;
  export function makeSearchFunc(
    config: IQDBClientConfig,
  ): (image: Buffer, options: IQDBSearchOptions) => Promise<IQDBSearchResponse>;
}
