/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatFetchResponseType, ChatLocation } from '../../../chat/common/commonTypes';
import { GenAiAttr, GenAiOperationName } from '../../../otel/common/index';
import { IOTelService, SpanKind, SpanStatusCode, type ISpanHandle } from '../../../otel/common/otelService';
import { ExtensionContributedChatEndpoint } from '../extChatEndpoint';

vi.mock('../../../requestLogger/node/requestLogger', () => ({
	storeCapturingTokenForCorrelation: vi.fn(),
	retrieveCapturingTokenByCorrelation: vi.fn(),
}));

class MockSpan implements ISpanHandle {
	public readonly attributes: Record<string, string | number | boolean | string[]> = {};
	public statusCode: SpanStatusCode = SpanStatusCode.UNSET;
	public statusMessage: string | undefined;
	public ended = false;
	public exceptions: unknown[] = [];

	setAttribute(key: string, value: string | number | boolean | string[]): void {
		this.attributes[key] = value;
	}
	setAttributes(attrs: Record<string, string | number | boolean | string[] | undefined>): void {
		for (const [k, v] of Object.entries(attrs)) {
			if (v !== undefined) {
				this.attributes[k] = v;
			}
		}
	}
	setStatus(code: SpanStatusCode, message?: string): void {
		this.statusCode = code;
		this.statusMessage = message;
	}
	recordException(error: unknown): void {
		this.exceptions.push(error);
	}
	addEvent(): void { /* no-op */ }
	getSpanContext() { return undefined; }
	end(): void { this.ended = true; }
}

class MockLanguageModelChat implements Partial<vscode.LanguageModelChat> {
	public readonly id = 'test.model';
	public readonly name = 'Test Model';
	public readonly version = '1.0.0';
	public readonly family = 'test';
	public readonly maxInputTokens = 8192;
	public readonly capabilities = {
		supportsToolCalling: false,
		supportsImageToText: false,
	};

	constructor(
		public readonly vendor: string,
		private readonly parts: readonly vscode.LanguageModelResponsePart[],
	) { }

	sendRequest(): Thenable<vscode.LanguageModelChatResponse> {
		const parts = this.parts;
		return Promise.resolve({
			stream: (async function* () {
				for (const part of parts) {
					yield part;
				}
			})(),
			text: (async function* () {
				for (const part of parts) {
					if (part instanceof vscode.LanguageModelTextPart) {
						yield part.value;
					}
				}
			})(),
		} as unknown as vscode.LanguageModelChatResponse);
	}

	countTokens(_input: string | vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage2, _token?: vscode.CancellationToken): Thenable<number> {
		return Promise.resolve(0);
	}
}

function createEndpoint(opts: {
	vendor: string;
	parts: readonly vscode.LanguageModelResponsePart[];
	captureContent?: boolean;
}): { endpoint: ExtensionContributedChatEndpoint; spans: MockSpan[] } {
	const languageModel = new MockLanguageModelChat(opts.vendor, opts.parts);
	const instantiationService = {} as unknown as IInstantiationService;
	const spans: MockSpan[] = [];
	const otelService = {
		config: { captureContent: opts.captureContent ?? true },
		getActiveTraceContext: () => undefined,
		startSpan: (_name: string, options?: { kind?: SpanKind; attributes?: Record<string, string | number | boolean | string[]> }) => {
			const span = new MockSpan();
			if (options?.attributes) {
				span.setAttributes(options.attributes);
			}
			spans.push(span);
			return span;
		},
	} as unknown as IOTelService;

	const endpoint = new ExtensionContributedChatEndpoint(languageModel as unknown as vscode.LanguageModelChat, instantiationService, otelService);
	return { endpoint, spans };
}

function createUserMessage(text: string): Raw.ChatMessage {
	return {
		role: Raw.ChatRole.User,
		content: [{ type: Raw.ChatCompletionContentPartKind.Text, text }],
	};
}

describe('ExtensionContributedChatEndpoint', () => {
	it('parses usage data by shape even when mime type is provider-specific', async () => {
		const usagePart = new vscode.LanguageModelDataPart(
			new TextEncoder().encode(JSON.stringify({
				prompt_tokens: 11,
				completion_tokens: 7,
				total_tokens: 18,
				prompt_tokens_details: { cached_tokens: 4 },
				completion_tokens_details: {
					reasoning_tokens: 2,
					accepted_prediction_tokens: 3,
					rejected_prediction_tokens: 1,
				},
			})),
			'application/vnd.provider.usage+json'
		);

		const { endpoint } = createEndpoint({
			vendor: 'xiaomi-mimo',
			parts: [new vscode.LanguageModelTextPart('hello'), usagePart],
		});

		const result = await endpoint.makeChatRequest2({
			debugName: 'test',
			messages: [createUserMessage('hi')],
			requestOptions: undefined,
			finishedCb: undefined,
			location: ChatLocation.Panel,
			source: undefined,
		}, new vscode.CancellationTokenSource().token);

		expect(result.type).toBe(ChatFetchResponseType.Success);
		if (result.type !== ChatFetchResponseType.Success) {
			return;
		}
		expect(result.usage.prompt_tokens).toBe(11);
		expect(result.usage.completion_tokens).toBe(7);
		expect(result.usage.total_tokens).toBe(18);
		expect(result.usage.prompt_tokens_details?.cached_tokens).toBe(4);
	});

	it('creates a fallback OTel chat span for third-party vendors', async () => {
		const { endpoint, spans } = createEndpoint({
			vendor: 'xiaomi-mimo',
			parts: [new vscode.LanguageModelTextPart('hello from mimo')],
			captureContent: true,
		});

		await endpoint.makeChatRequest2({
			debugName: 'panel/agent',
			messages: [createUserMessage('hi')],
			requestOptions: undefined,
			finishedCb: undefined,
			location: ChatLocation.Panel,
			source: undefined,
		}, new vscode.CancellationTokenSource().token);

		expect(spans).toHaveLength(1);
		const span = spans[0];
		expect(span.ended).toBe(true);
		expect(span.statusCode).toBe(SpanStatusCode.OK);
		expect(span.attributes[GenAiAttr.OPERATION_NAME]).toBe(GenAiOperationName.CHAT);
		expect(span.attributes[GenAiAttr.PROVIDER_NAME]).toBe('xiaomi-mimo');
		expect(span.attributes[GenAiAttr.REQUEST_MODEL]).toBe('test.model');
		expect(span.attributes[GenAiAttr.AGENT_NAME]).toBe('panel/agent');
		expect(span.attributes[GenAiAttr.INPUT_MESSAGES]).toBeDefined();
		expect(span.attributes[GenAiAttr.OUTPUT_MESSAGES]).toBeDefined();
	});

	it('does not create a fallback OTel chat span for built-in BYOK vendors', async () => {
		const { endpoint, spans } = createEndpoint({
			vendor: 'Anthropic',
			parts: [new vscode.LanguageModelTextPart('hello')],
		});

		await endpoint.makeChatRequest2({
			debugName: 'test',
			messages: [createUserMessage('hi')],
			requestOptions: undefined,
			finishedCb: undefined,
			location: ChatLocation.Panel,
			source: undefined,
		}, new vscode.CancellationTokenSource().token);

		expect(spans).toHaveLength(0);
	});
});
