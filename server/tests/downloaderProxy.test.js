import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { getSmartProxyArgs, isLocalPortListening } from '../services/downloader.js';

vi.mock('fs');

describe('downloaderProxy getSmartProxyArgs', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.RESIDENTIAL_PROXY;
    delete process.env.PROXY_URL;
    delete process.env.YTDLP_PROXY_REQUIRED;
  });

  it('should return empty array if no proxy is configured', () => {
    expect(getSmartProxyArgs()).toEqual([]);
  });

  it('should return proxy args if proxy is not localhost', () => {
    process.env.PROXY_URL = 'http://192.168.1.100:8080';
    expect(getSmartProxyArgs()).toEqual(['--proxy', 'http://192.168.1.100:8080']);
  });

  it('should return proxy args if localhost proxy is listening', () => {
    process.env.PROXY_URL = 'socks5h://127.0.0.1:10808';
    fs.existsSync.mockImplementation((path) => {
      if (path === '/proc/net/tcp') return true;
      return false;
    });
    fs.readFileSync.mockImplementation((path) => {
      if (path === '/proc/net/tcp') {
        // 10808 in hex is 2A38
        return ' 0: 00000000:2A38 00000000:0000 0A ';
      }
      return '';
    });
    expect(getSmartProxyArgs()).toEqual(['--proxy', 'socks5h://127.0.0.1:10808']);
  });

  it('should return empty array if localhost proxy is NOT listening and YTDLP_PROXY_REQUIRED is 0', () => {
    process.env.PROXY_URL = 'socks5h://127.0.0.1:10808';
    process.env.YTDLP_PROXY_REQUIRED = '0';
    fs.existsSync.mockImplementation((path) => {
      if (path === '/proc/net/tcp') return true;
      return false;
    });
    fs.readFileSync.mockImplementation((path) => {
      if (path === '/proc/net/tcp') {
        return ' 0: 00000000:0050 00000000:0000 0A '; // 80, not 10808
      }
      return '';
    });
    expect(getSmartProxyArgs()).toEqual([]);
  });

  it('should throw Error if localhost proxy is NOT listening and YTDLP_PROXY_REQUIRED is 1', () => {
    process.env.PROXY_URL = 'socks5h://127.0.0.1:10808';
    process.env.YTDLP_PROXY_REQUIRED = '1';
    fs.existsSync.mockImplementation((path) => {
      if (path === '/proc/net/tcp') return true;
      return false;
    });
    fs.readFileSync.mockImplementation((path) => {
      if (path === '/proc/net/tcp') {
        return ' 0: 00000000:0050 00000000:0000 0A ';
      }
      return '';
    });
    expect(() => getSmartProxyArgs()).toThrow(/Proxy HP tidak tersambung/);
  });
});
