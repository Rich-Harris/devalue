import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

export const javascriptHighlightStyle = HighlightStyle.define([
	{ tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword], color: '#f5a524' },
	{ tag: [tags.typeName, tags.className, tags.namespace], color: '#5eead4' },
	{ tag: [tags.string, tags.special(tags.string)], color: '#86d98b' },
	{ tag: [tags.number, tags.bool, tags.null], color: '#f6c85f' },
	{
		tag: [tags.lineComment, tags.blockComment, tags.docComment],
		color: '#7f8c9f',
		fontStyle: 'italic'
	},
	{ tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#c4b5fd' },
	{ tag: tags.propertyName, color: '#7dd3fc' },
	{ tag: [tags.variableName, tags.definition(tags.variableName)], color: '#e5e7eb' },
	{
		tag: [tags.operator, tags.updateOperator, tags.logicOperator, tags.compareOperator],
		color: '#fb7185'
	},
	{ tag: [tags.punctuation, tags.bracket, tags.separator], color: '#94a3b8' }
]);

export const javascriptSyntaxHighlighting = syntaxHighlighting(javascriptHighlightStyle);
