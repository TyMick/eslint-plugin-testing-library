import { ASTUtils, ESLintUtils } from '@typescript-eslint/utils';

import { createTestingLibraryRule } from '../create-testing-library-rule';
import {
	getDeepestIdentifierNode,
	isLiteral,
	isMemberExpression,
} from '../node-utils';
import {
	ALL_QUERIES_COMBINATIONS,
	ALL_RETURNING_NODES,
	EVENT_HANDLER_METHODS,
	resolveToTestingLibraryFn,
} from '../utils';

import type { TSESTree } from '@typescript-eslint/utils';
import type * as ts from 'typescript';

const RULE_NAME = 'no-node-access';

// Core DOM interfaces whose names are used to identify DOM node types.
// If an accessed object's TypeScript type is (or extends) one of these, the
// rule considers it a genuine DOM node and will report the access.
// These are the root interfaces of the DOM type hierarchy in lib.dom.d.ts.
const DOM_NODE_TYPE_NAMES = new Set([
	'Node',
	'Element',
	'HTMLElement',
	'SVGElement',
	'EventTarget',
	'Document',
	'Window',
	'ShadowRoot',
	'DocumentFragment',
]);

function isDOMNodeType(type: ts.Type, checker: ts.TypeChecker): boolean {
	// Handle union types — if any constituent is a DOM type, treat as DOM
	if (type.isUnion()) {
		return type.types.some((t) => isDOMNodeType(t, checker));
	}

	const symbol = type.getSymbol() ?? type.aliasSymbol;
	if (symbol && DOM_NODE_TYPE_NAMES.has(symbol.getName())) {
		return true;
	}

	// Walk base types recursively
	const baseTypes = checker.getBaseTypes(type as ts.InterfaceType);
	if (baseTypes.length > 0) {
		return baseTypes.some((base) => isDOMNodeType(base, checker));
	}

	return false;
}

export type MessageIds = 'noNodeAccess';
export type Options = [{ allowContainerFirstChild: boolean }];

export default createTestingLibraryRule<Options, MessageIds>({
	name: RULE_NAME,
	meta: {
		type: 'problem',
		docs: {
			description:
				'Disallow direct Node access. When type information is available, only flags actual DOM node access.',
			recommendedConfig: {
				dom: 'error',
				angular: 'error',
				react: 'error',
				vue: 'error',
				svelte: 'error',
				marko: 'error',
			},
		},
		messages: {
			noNodeAccess:
				'Avoid direct Node access. Prefer using the methods from Testing Library.',
		},
		schema: [
			{
				type: 'object',
				properties: {
					allowContainerFirstChild: {
						type: 'boolean',
					},
				},
				additionalProperties: false,
			},
		],
	},
	defaultOptions: [
		{
			allowContainerFirstChild: false,
		},
	],

	create(context, [{ allowContainerFirstChild = false }], helpers) {
		function showErrorForNodeAccess(node: TSESTree.MemberExpression) {
			// This rule is so aggressive that can cause tons of false positives outside test files when Aggressive Reporting
			// is enabled. Because of that, this rule will skip this mechanism and report only if some Testing Library package
			// or custom one (set in utils-module Shared Setting) is found.
			if (!helpers.isTestingLibraryImported(true)) {
				return;
			}

			const propertyName = ASTUtils.isIdentifier(node.property)
				? node.property.name
				: null;

			if (
				propertyName &&
				ALL_RETURNING_NODES.some(
					(allReturningNode) => allReturningNode === propertyName
				)
			) {
				// Type-aware guard: when TypeScript type information is available, only
				// report if the object being accessed is actually a DOM Node type.
				// When type info is not available, fall through to the existing behaviour.
				const services = ESLintUtils.getParserServices(context, true);
				if (services.program != null) {
					const checker = services.program.getTypeChecker();
					const tsNode = services.esTreeNodeToTSNodeMap.get(node.object);
					const type = checker.getTypeAtLocation(tsNode);
					if (!isDOMNodeType(type, checker)) {
						return;
					}
				}

				if (allowContainerFirstChild && propertyName === 'firstChild') {
					return;
				}

				if (
					ASTUtils.isIdentifier(node.object) &&
					node.object.name === 'props'
				) {
					return;
				}

				context.report({
					node,
					loc: node.property.loc.start,
					messageId: 'noNodeAccess',
				});
			}
		}

		function getProperty(
			node: TSESTree.PrivateIdentifier | TSESTree.Expression
		) {
			if (isLiteral(node)) {
				return node;
			}

			return getDeepestIdentifierNode(node);
		}

		return {
			CallExpression(node: TSESTree.CallExpression) {
				if (!isMemberExpression(node.callee)) return;

				const { callee } = node;
				if (
					!EVENT_HANDLER_METHODS.some(
						(method) => method === ASTUtils.getPropertyName(callee)
					)
				) {
					return;
				}
				const identifier = getDeepestIdentifierNode(callee.object);

				if (
					!identifier ||
					!ALL_QUERIES_COMBINATIONS.includes(identifier.name)
				) {
					return;
				}

				if (resolveToTestingLibraryFn(node, context)) {
					const property = getProperty(callee.property);
					context.report({
						node,
						loc: property?.loc.start,
						messageId: 'noNodeAccess',
					});
				}
			},
			'ExpressionStatement MemberExpression': showErrorForNodeAccess,
			'VariableDeclarator MemberExpression': showErrorForNodeAccess,
		};
	},
});
