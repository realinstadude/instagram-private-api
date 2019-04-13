import { inRange, random, defaultsDeep } from 'lodash';
import { Subject } from 'rxjs';
import * as request from 'request-promise';
import { Options, Response } from 'request';
import hmac = require('crypto-js/hmac-sha256');
import { IgApiClient } from '../client';
import {
  IgActionSpamError,
  IgLoginRequiredError,
  IgCheckpointError,
  IgNotFoundError,
  IgPrivateUserError,
  IgResponseError,
  IgSentryBlockError,
  IgNetworkError,
} from '../errors';

type Payload = { [key: string]: any } | string;

interface SignedPost {
  signed_body: string;
  ig_sig_key_version: string;
}

export class Request {
  end$ = new Subject();
  constructor(private client: IgApiClient) {}

  private static requestTransform(body, response: Response, resolveWithFullResponse) {
    try {
      // Sometimes we have numbers greater than Number.MAX_SAFE_INTEGER in json response
      // To handle it we just wrap numbers with length > 15 it double quotes to get strings instead
      response.body = JSON.parse(body.replace(/([\[:])?(-?[\d.]{15,})(\s*?[,}\]])/gi, `$1"$2"$3`));
    } catch (e) {
      if (inRange(response.statusCode, 200, 299)) {
        throw e;
      }
    }
    return resolveWithFullResponse ? response : response.body;
  }

  private handleResponseError(response: Response) {
    const json = response.body;
    if (json.spam) {
      return new IgActionSpamError(response);
    }
    if (response.statusCode === 404) {
      return new IgNotFoundError(response);
    }
    if (typeof json.message === 'string') {
      if (json.message === 'challenge_required') {
        this.client.state.checkpoint = json;
        return new IgCheckpointError(response);
      }
      if (json.message === 'login_required') {
        return new IgLoginRequiredError(response);
      }
      if (json.message.toLowerCase() === 'not authorized to view user') {
        return new IgPrivateUserError(response);
      }
    }
    if (json.error_type === 'sentry_block') {
      return new IgSentryBlockError(response);
    }
    return new IgResponseError(response);
  }

  public async send<T = any>(
    userOptions: Options,
  ): Promise<Pick<Response, Exclude<keyof Response, 'body'>> & { body: T }> {
    const options = defaultsDeep(userOptions, {
      baseUrl: 'https://i.instagram.com/',
      resolveWithFullResponse: true,
      proxy: this.client.state.proxyUrl,
      simple: false,
      transform: Request.requestTransform,
      jar: this.client.state.cookieJar,
      strictSSL: false,
      gzip: true,
      headers: this.getDefaultHeaders(),
    });
    let response;
    try {
      response = await request(options);
    } catch (e) {
      throw new IgNetworkError(e);
    }
    process.nextTick(() => this.end$.next());
    if (response.body.status === 'ok') {
      return response;
    }
    throw this.handleResponseError(response);
  }

  public sign(payload: Payload): string {
    const json = typeof payload === 'object' ? JSON.stringify(payload) : payload;
    const signature = hmac(json, this.client.state.signatureKey).toString();
    return `${signature}.${json}`;
  }

  public signPost(payload: Payload): SignedPost {
    if (typeof payload === 'object' && !payload._csrftoken) {
      payload._csrftoken = this.client.state.CSRFToken;
    }
    const signed_body = this.sign(payload);
    return {
      ig_sig_key_version: this.client.state.signatureVersion,
      signed_body,
    };
  }

  private getDefaultHeaders() {
    return {
      'X-FB-HTTP-Engine': 'Liger',
      'X-IG-Connection-Type': 'WIFI',
      'X-IG-Capabilities': '3brTPw==',
      'X-IG-Connection-Speed': `${random(1000, 3700)}kbps`,
      'X-IG-Bandwidth-Speed-KBPS': '-1.000',
      'X-IG-Bandwidth-TotalBytes-B': '0',
      'X-IG-Bandwidth-TotalTime-MS': '0',
      Host: 'i.instagram.com',
      Accept: '*/*',
      'Accept-Encoding': 'gzip,deflate',
      Connection: 'Keep-Alive',
      'User-Agent': this.client.state.appUserAgent,
      'X-IG-App-ID': this.client.state.fbAnalyticsApplicationId,
      'Accept-Language': this.client.state.language.replace('_', '-'),
    };
  }
}