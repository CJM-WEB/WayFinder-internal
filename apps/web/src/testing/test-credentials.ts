/** 测试专用凭据：协调器回归显式注入假Key，不触发真实资格接口或读取浏览器设置。 */
import type { SearchCredentials } from "@wayfinder/contracts";

export const testCredentials: SearchCredentials = {
  deepseek: { source: "own", apiKey: "test-deepseek-key" },
  serpapi: { source: "own", apiKey: "test-serpapi-key" },
};
export const prepareTestCredentials = async (): Promise<SearchCredentials> => testCredentials;
