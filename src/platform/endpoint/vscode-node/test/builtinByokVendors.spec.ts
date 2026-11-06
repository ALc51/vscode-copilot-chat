/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { isCopilotBuiltinByokVendor } from '../builtinByokVendors';

describe('isCopilotBuiltinByokVendor', () => {
	it('recognizes built-in BYOK vendors case-insensitively', () => {
		expect(isCopilotBuiltinByokVendor('Anthropic')).toBe(true);
		expect(isCopilotBuiltinByokVendor('openai')).toBe(true);
		expect(isCopilotBuiltinByokVendor('CustomOAI')).toBe(true);
		expect(isCopilotBuiltinByokVendor('xAI')).toBe(true);
	});

	it('treats third-party extension vendors as non-builtin', () => {
		expect(isCopilotBuiltinByokVendor('xiaomi-mimo')).toBe(false);
		expect(isCopilotBuiltinByokVendor('my-provider')).toBe(false);
		expect(isCopilotBuiltinByokVendor(undefined)).toBe(false);
		expect(isCopilotBuiltinByokVendor('')).toBe(false);
	});
});
