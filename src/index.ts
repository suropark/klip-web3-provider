// Copyright (c) 2018-2022 Coinbase, Inc. <https://www.coinbase.com/>
// Licensed under the Apache License, version 2.0
// This file is derived from coinbase-wallet-sdk/packages/wallet-sdk/src/provider/CoinbaseWalletProvider.ts (2022/08/01).
// Modified for the klip-web3-provider development.

const { prepare, getResult, request } = require('klip-sdk');
import SafeEventEmitter from '@metamask/safe-event-emitter';
import { ethErrors } from 'eth-rpc-errors';

import QRCodeModal from './klip-qrcode-modal';
import { JSONRPCResponse, JSONRPCRequest, JSONRPCMethod } from './JSONRPC';
import { Web3Provider, RequestArguments } from './Web3Provider';
import { SubscriptionManager, SubscriptionNotification, SubscriptionResult } from './SubscriptionManager';
import { BytesLike, Signature, ethers } from 'ethers';
import axios from 'axios';
const CypressChainId = '0x2019';
const ErrorMsgUndefined = 'RPC Url is not provided or chain id is different from Klaytn Mainnet.';
const PublicRpcUrl = 'https://klaytn.blockpi.network/v1/rpc/public';

const prepareUrl = 'https://a2a-api.klipwallet.com/v2/a2a/prepare';
const requestUrl = 'https://klipwallet.com/?target=/a2a?request_key=';
const resultUrl = 'https://a2a-api.klipwallet.com/v2/a2a/result?request_key=';
export type Callback<T> = (err: Error | null, result: T | null) => void;

export interface IKlipProviderOptions {
    bappName?: string;
    rpcUrl?: string;
}

export interface IQRCodeModalOptions {
    registryUrl?: string;
    mobileLinks?: string[];
    desktopLinks?: string[];
}

export class KlipWeb3Provider extends SafeEventEmitter implements Web3Provider {
    public qrcode = true;
    public chainId = '';
    public qrcodeModal = QRCodeModal;
    public qrcodeModalOptions: IQRCodeModalOptions | undefined = undefined;
    public bappName = '';
    public rpcUrl = '';
    public ethersProvider: any;
    public ethersEnabled = false;
    private readonly _subscriptionManager = new SubscriptionManager(this);
    private _addresses: string[] = [];

    constructor(opts: IKlipProviderOptions) {
        super({});
        this.bappName = opts.bappName ? opts.bappName : 'undefined';
        this.rpcUrl = opts.rpcUrl ? opts.rpcUrl : PublicRpcUrl;
        this.ethersProvider = new ethers.providers.JsonRpcProvider(this.rpcUrl);
        this.chainId = this.getChainId();
        this._subscriptionManager.events.on('notification', (notification: SubscriptionNotification) => {
            this.emit('message', {
                type: notification.method,
                data: notification.params,
            });
        });
    }

    private async _checkRpcUrl(): Promise<boolean> {
        const chainId = (await this.ethersProvider.getNetwork()).chainId;
        return chainId === Number(CypressChainId);
    }

    public getChainId(): string {
        return CypressChainId;
    }

    public get connected(): boolean {
        return true;
    }

    public supportsSubscriptions(): boolean {
        return false;
    }

    public disconnect(): boolean {
        return true;
    }

    public send(request: JSONRPCRequest): JSONRPCResponse;
    public send(request: JSONRPCRequest[]): JSONRPCResponse[];
    public send(request: JSONRPCRequest, callback: Callback<JSONRPCResponse>): void;
    public send(request: JSONRPCRequest[], callback: Callback<JSONRPCResponse[]>): void;
    public send<T = any>(method: string, params?: any[] | any): Promise<T>;
    public send(
        requestOrMethod: JSONRPCRequest | JSONRPCRequest[] | string,
        callbackOrParams?: Callback<JSONRPCResponse> | Callback<JSONRPCResponse[]> | any[] | any,
    ): JSONRPCResponse | JSONRPCResponse[] | void | Promise<any> {
        // send<T>(method, params): Promise<T>
        if (typeof requestOrMethod === 'string') {
            const method = requestOrMethod;
            const params = Array.isArray(callbackOrParams)
                ? callbackOrParams
                : callbackOrParams !== undefined
                ? [callbackOrParams]
                : [];
            const request: JSONRPCRequest = {
                jsonrpc: '2.0',
                id: 0,
                method,
                params,
            };
            return this._sendRequestAsync(request).then((res) => res.result);
        }

        // send(JSONRPCRequest | JSONRPCRequest[], callback): void
        if (typeof callbackOrParams === 'function') {
            const request = requestOrMethod as any;
            const callback = callbackOrParams;
            return this._sendAsync(request, callback);
        }

        // send(JSONRPCRequest[]): JSONRPCResponse[]
        if (Array.isArray(requestOrMethod)) {
            const requests = requestOrMethod;
            return requests.map((r) => this._sendRequest(r));
        }

        // send(JSONRPCRequest): JSONRPCResponse
        const req: JSONRPCRequest = requestOrMethod;
        return this._sendRequest(req);
    }

    public sendAsync(request: JSONRPCRequest, callback: Callback<JSONRPCResponse>): void;
    public sendAsync(request: JSONRPCRequest[], callback: Callback<JSONRPCResponse[]>): void;

    public async sendAsync(
        request: JSONRPCRequest | JSONRPCRequest[],
        callback: Callback<JSONRPCResponse> | Callback<JSONRPCResponse[]>,
    ): Promise<void> {
        if (typeof callback !== 'function') {
            throw new Error('callback is required');
        }

        // send(JSONRPCRequest[], callback): void
        if (Array.isArray(request)) {
            const arrayCb = callback as Callback<JSONRPCResponse[]>;
            this._sendMultipleRequestsAsync(request)
                .then((responses) => arrayCb(null, responses))
                .catch((err) => arrayCb(err, null));
            return;
        }

        // send(JSONRPCRequest, callback): void
        const cb = callback as Callback<JSONRPCResponse>;
        return this._sendRequestAsync(request)
            .then((response) => cb(null, response))
            .catch((err) => cb(err, null));
    }

    public async request<T>(args: RequestArguments): Promise<T> {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
            throw ethErrors.rpc.invalidRequest({
                message: 'Expected a single, non-array, object argument.',
                data: args,
            });
        }

        const { method, params } = args;

        if (typeof method !== 'string' || method.length === 0) {
            throw ethErrors.rpc.invalidRequest({
                message: "'args.method' must be a non-empty string.",
                data: args,
            });
        }

        if (params !== undefined && !Array.isArray(params) && (typeof params !== 'object' || params === null)) {
            throw ethErrors.rpc.invalidRequest({
                message: "'args.params' must be an object or array if provided.",
                data: args,
            });
        }

        const newParams = params === undefined ? [] : params;

        const res = await this._sendRequestAsync({
            method,
            params: newParams,
            jsonrpc: '2.0',
            id: 0,
        });
        return res.result as T;
    }

    private _send = this.send.bind(this);
    private _sendAsync = this.sendAsync.bind(this);

    private _sendRequest(request: JSONRPCRequest): JSONRPCResponse {
        const response: JSONRPCResponse = {
            jsonrpc: '2.0',
            id: request.id,
        };
        const { method } = request;

        response.result = this._handleSynchronousMethods(request);

        if (response.result === undefined) {
            throw new Error(
                `Klip Wallet does not support calling ${method} synchronously without ` +
                    `a callback. Please provide a callback parameter to call ${method} ` +
                    `asynchronously.`,
            );
        }
        return response;
    }

    private _sendRequestAsync(request: JSONRPCRequest): Promise<JSONRPCResponse> {
        return new Promise<JSONRPCResponse>((resolve, reject) => {
            try {
                const syncResult = this._handleSynchronousMethods(request);
                if (syncResult !== undefined) {
                    return resolve({
                        jsonrpc: '2.0',
                        id: request.id,
                        result: syncResult,
                    });
                }

                const subscriptionPromise = this._handleSubscriptionMethods(request);
                if (subscriptionPromise !== undefined) {
                    subscriptionPromise
                        .then((res) =>
                            resolve({
                                jsonrpc: '2.0',
                                id: request.id,
                                result: res.result,
                            }),
                        )
                        .catch((err) => reject(err));
                    return;
                }
            } catch (err: any) {
                return reject(err);
            }

            this._handleAsynchronousMethods(request)
                .then((res) => res && resolve({ ...res, id: request.id }))
                .catch((err) => reject(err));
        });
    }

    private _handleSubscriptionMethods(request: JSONRPCRequest): Promise<SubscriptionResult> | undefined {
        switch (request.method) {
            case JSONRPCMethod.eth_subscribe:
            case JSONRPCMethod.eth_unsubscribe:
                return this._subscriptionManager.handleRequest(request);
        }

        return undefined;
    }
    private _sendMultipleRequestsAsync(requests: JSONRPCRequest[]): Promise<JSONRPCResponse[]> {
        return Promise.all(requests.map((r) => this._sendRequestAsync(r)));
    }

    private _handleSynchronousMethods(request: JSONRPCRequest) {
        const { method } = request;

        switch (method) {
            case JSONRPCMethod.eth_accounts:
                return this._eth_accounts();

            case JSONRPCMethod.net_version:
                return this._net_version();

            case JSONRPCMethod.eth_chainId:
                return this._eth_chainId();

            default:
                return undefined;
        }
    }

    private async _handleAsynchronousMethods(request: JSONRPCRequest): Promise<JSONRPCResponse | void> {
        const { method } = request;
        const params = request.params || [];
        switch (method) {
            case JSONRPCMethod.personal_sign:
                return this._personal_sign(params);
            case JSONRPCMethod.eth_sendTransaction:
                return this._eth_sendTransaction(params);
            case JSONRPCMethod.personal_ecRecover:
                return this._personal_ecRecover(params);
            case JSONRPCMethod.eth_blockNumber:
                return this._eth_blockNumber();
            case JSONRPCMethod.eth_getBlockByNumber:
                return this._eth_getBlockByNumber(params);
            case JSONRPCMethod.eth_getGasPrice:
                return this._eth_getGasPrice();
            case JSONRPCMethod.eth_getTransactionReceipt:
                return this._eth_getTransactionReceipt(params);
            case JSONRPCMethod.eth_call:
                return this._eth_call(params);
            case JSONRPCMethod.eth_getBalance:
                return this._eth_getBalance(params);
            case JSONRPCMethod.eth_estimateGas:
                return this._eth_estimateGas(params);
            case JSONRPCMethod.eth_getTransactionByHash:
                return this._eth_getTransactionByHash(params);
        }
        throw new Error(`${method} is not supported in klip-web3-provider.`);
    }

    get isWalletConnect() {
        return true;
    }

    enable = async (): Promise<string[]> => {
        if (this.ethersProvider != undefined) {
            this.ethersEnabled = await this._checkRpcUrl();
        }
        if (this._addresses.length > 0) {
            return this._addresses;
        }
        return new Promise(async (resolve, reject) => {
            const res = await prepare.auth({ bappName: this.bappName });
            if (res.err) {
                return reject(res.err);
            } else if (res.request_key) {
                const klipLink = requestUrl + res.request_key;
                await request(klipLink, () => {});
                this.qrcodeModal.open(klipLink, () => {
                    this.emit('modal_closed');
                });
                const interval = setInterval(() => {
                    getResult(res.request_key).then((data: any) => {
                        if (data.status == 'completed') {
                            this.qrcodeModal.close();
                            clearInterval(interval);
                            this._addresses = [data.result.klaytn_address];
                            return resolve([data.result.klaytn_address]);
                        } else if (data.status == 'canceled' || data.status == 'error') {
                            this.qrcodeModal.close();
                            clearInterval(interval);
                            this._addresses = [];
                            return reject(new Error('Process is canceled or error occurs'));
                        }
                    });
                }, 1000);
                this.on('modal_closed', () => {
                    clearInterval(interval);
                    return reject(new Error('QRCode modal is closed!'));
                });
            }
        });
    };

    private _eth_accounts(): string[] {
        return [...this._addresses];
    }

    private _net_version(): number {
        return 8217;
    }

    private _eth_chainId(): string {
        return this.getChainId();
    }

    private async _personal_sign(params: unknown[]): Promise<JSONRPCResponse> {
        return new Promise<JSONRPCResponse>(async (resolve, reject) => {
            const bappName = this.bappName;
            const value = typeof params[0] === 'string' ? params[0] : 'undefined'; //message
            const from = params[1];
            const res = await axios
                .post(prepareUrl, {
                    bapp: {
                        name: bappName,
                    },
                    type: 'sign_message',
                    chain: 'klaytn',
                    message: {
                        is_hex_encoded: false,
                        value: value,
                    },
                })
                .then((res) => res.data);

            if (res.err) {
                return reject(res.err);
            } else if (res.request_key) {
                const klipLink = requestUrl + res.request_key;
                await request(klipLink, () => {});
                this.qrcodeModal.open(klipLink, () => {
                    this.emit('modal_closed');
                });
                const interval = setInterval(() => {
                    getResult(res.request_key).then((data: any) => {
                        if (data.status == 'completed') {
                            this.qrcodeModal.close();
                            clearInterval(interval);
                            return resolve({
                                jsonrpc: '2.0',
                                id: 0,
                                result: data.result.signature,
                            });
                        } else if (data.status == 'canceled' || data.status == 'error') {
                            this.qrcodeModal.close();
                            clearInterval(interval);
                            return reject(new Error('Process is canceled or error occurs'));
                        }
                    });
                }, 1000);
                this.on('modal_closed', () => {
                    clearInterval(interval);
                    return reject(new Error('QRCode modal is closed!'));
                });
            }
        });
    }

    private async _eth_sendTransaction(params: any[]): Promise<JSONRPCResponse> {
        // send token transaction & send klay transaction
        return new Promise<JSONRPCResponse>(async (resolve, reject) => {
            const bappName = this.bappName;
            const to = params[0]['to'];
            const data = params[0]['data'];
            const amount = Number(params[0]['value'] ?? 0).toString();
            const res = await axios
                .post(prepareUrl, {
                    bapp: {
                        name: bappName,
                    },
                    type: 'execute_contract',
                    transaction: {
                        to,
                        value: amount,
                        encoded_function_call: data,
                    },
                })
                .then((res) => res.data);

            if (res.err) {
                return reject(res.err);
            } else if (res.request_key) {
                const klipLink = requestUrl + res.request_key;

                await request(klipLink, () => {});
                this.qrcodeModal.open(klipLink, () => {
                    this.emit('modal_closed');
                });
                const interval = setInterval(() => {
                    getResult(res.request_key).then((data: any) => {
                        if (data.status == 'completed') {
                            this.qrcodeModal.close();
                            clearInterval(interval);
                            return resolve({
                                jsonrpc: '2.0',
                                id: 0,
                                result: data.result.tx_hash,
                            });
                        } else if (data.status == 'canceled' || data.status == 'error') {
                            this.qrcodeModal.close();
                            clearInterval(interval);
                            return reject(new Error('Process is canceled or error occurs'));
                        }
                    });
                }, 1000);
                this.on('modal_closed', () => {
                    clearInterval(interval);
                    return reject(new Error('QRCode modal is closed!'));
                });
            }
        });
    }

    private async _eth_call(params: unknown[]): Promise<JSONRPCResponse> {
        this._checkProvider();
        const result = await this.ethersProvider.send('eth_call', params);
        return { jsonrpc: '2.0', id: 0, result };
    }

    private async _personal_ecRecover(params: unknown[]): Promise<JSONRPCResponse> {
        this._checkProvider();
        const address = await ethers.utils.recoverAddress(params[0] as BytesLike, params[1] as Signature);
        return { jsonrpc: '2.0', id: 0, result: address };
    }

    private async _eth_getTransactionReceipt(params: unknown[]): Promise<JSONRPCResponse> {
        this._checkProvider();
        const txHash = params[0] as string;
        const receipt = await this.ethersProvider.getTransactionReceipt(txHash);
        return { jsonrpc: '2.0', id: 0, result: receipt };
    }

    private async _eth_blockNumber(): Promise<JSONRPCResponse> {
        this._checkProvider();
        const blockNumber = await this.ethersProvider.getBlockNumber();
        return { jsonrpc: '2.0', id: 0, result: blockNumber };
    }

    private async _eth_getBlockByNumber(params: unknown[]): Promise<JSONRPCResponse> {
        this._checkProvider();
        const block = await this.ethersProvider.getBlock(params[0]);
        return { jsonrpc: '2.0', id: 0, result: block };
    }

    private async _eth_getGasPrice(): Promise<JSONRPCResponse> {
        this._checkProvider();
        const result = await this.ethersProvider.getGasPrice();
        return { jsonrpc: '2.0', id: 0, result: result };
    }
    private async _eth_getBalance(params: unknown[]): Promise<JSONRPCResponse> {
        this._checkProvider();

        const result = await this.ethersProvider.getBalance(params[0]);
        return { jsonrpc: '2.0', id: 0, result };
    }
    private async _eth_getTransactionByHash(params: unknown[]): Promise<JSONRPCResponse> {
        this._checkProvider();
        const result = await this.ethersProvider.send('eth_getTransactionByHash', params);
        return { jsonrpc: '2.0', id: 0, result };
    }

    private async _eth_estimateGas(params: unknown[]): Promise<JSONRPCResponse> {
        this._checkProvider();
        const result = await this.ethersProvider.estimateGas(params[0]);
        return { jsonrpc: '2.0', id: 0, result };
    }

    private _checkProvider() {
        if (this.ethersProvider == undefined || !this.ethersEnabled) {
            throw new Error(ErrorMsgUndefined);
        }
    }
}
