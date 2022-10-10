import {escape_for_html, hex_cp} from './utils.js';

function hex_seq(cps) {
	return cps.map(hex_cp).join(' ');
}

function create_arrow_span() {
	let span = document.createElement('span');
	span.classList.add('arrow');
	span.innerHTML = '➔'; //'&rarr;';
	return span;
}

function span_from_cp(cp) {
	let span = document.createElement('span');
	if (cp == 0x200D) {
		span.classList.add('mod', 'zwj');
		span.innerHTML = 'ZWJ';
	} else if (cp == 0x200C) {
		span.classList.add('mod', 'zwj');
		span.innerHTML = 'ZWNJ';
	} else if (cp == 0xFE0F) {
		span.classList.add('mod', 'dropped', 'style');
		span.innerHTML = 'FE0F';
	} else if (cp == 0x20E3) {
		span.classList.add('mod', 'keycap');
		span.innerHTML = 'Keycap';
	} else if (cp >= 0xE0020 && cp <= 0xE007F) {
		cp -= 0xE0000;
		let ch = String.fromCodePoint(cp);
		let form;
		span.classList.add('mod', 'tag');
		if (cp === 0x7F) {
			form = 'End';
		} else {
			form = escape_for_html(ch);
			if (form !== ch) span.classList.add('code');
		}
		span.innerHTML = `<span class="tag">${form}<sub>🏷️</sub></span>`
	} else {
		let ch = String.fromCodePoint(cp);
		let form = escape_for_html(ch, hex_cp);
		if (form !== ch) span.classList.add('code');
		span.classList.add('raw');
		span.innerHTML = form;
	}
	return span;
}

// title, dislayed_cps, token?
function default_titler(title, cps, token) {
	return `${title}\n${hex_seq(cps)}`;
}

export function dom_from_tokens(tokens, {
	before = false, 
	components = true, 
	titler = default_titler,
	emoji_url = 'https://emojipedia.org/%s'
} = {}) {
	let div = document.createElement('div');
	div.classList.add('tokens');
	if (before) {
		// dont use normalized form
		tokens = tokens.flatMap(token => {
			if (token.type === 'nfc') {
				return token.tokens;
			} else {
				return token;
			}
		});
	}
	div.append(...tokens.flatMap(token => {
		let el;
		if (token.type === 'emoji') {
			let cps = before ? token.input : token.cps;
			el = document.createElement('a');
			el.href = emoji_url.replace('%s', String.fromCodePoint(...token.emoji));
			el.title = titler('Emoji', cps, token);
			el.classList.add('glyph');
			if (components) {
				el.append(...cps.map(cp => span_from_cp(cp)));
			} else {
				el.innerHTML = String.fromCodePoint(...token.emoji);
			}
		} else if (token.type === 'nfc') {
			el = document.createElement('div');
			el.classList.add('nfc');
			let lhs = dom_from_tokens(token.tokens, false);
			lhs.classList.add('before');
			let rhs = document.createElement('div');
			rhs.classList.add('valid');
			rhs.innerHTML = String.fromCodePoint(...token.cps);
			rhs.title = titler('NFC', token.cps, token); 
			el.append(lhs, create_arrow_span(), rhs);
		} else {
			el = document.createElement('div');
			if (token.type === 'valid') {
				el.classList.add('valid');
				el.innerHTML = String.fromCodePoint(...token.cps);
				el.title = titler('Valid', token.cps, token);
			} else if (token.type === 'mapped') {
				el.classList.add('mapped');
				let span = document.createElement('span');
				span.classList.add('before');
				span.innerHTML = String.fromCodePoint(token.cp);	
				span.title = titler('Mapped', [token.cp], token);
				el.append(span);
				if (!before) {
					let span_dst = document.createElement('span');
					span_dst.innerHTML = token.cps.map(x => String.fromCodePoint(x)).join('\u{A0}');
					span_dst.title = titler('Mapped (Output)', token.cps, token);
					el.append(create_arrow_span(), span_dst);
				}
			} else if (token.type === 'ignored') {
				el.innerHTML = hex_cp(token.cp); 
				el.title = titler('Ignored', [token.cp]);
				el.classList.add('ignored');
			} else if (token.type === 'disallowed') {
				el = span_from_cp(token.cp);
				el.classList.add('disallowed');
				el.title = titler('Disallowed', [token.cp]);
			} else if (token.type === 'stop') {
				el.classList.add('stop');
				el.innerHTML = '.';
			} else if (token.type === 'isolated') {
				el.classList.add('isolated');
				el.innerHTML = String.fromCodePoint(token.cp);
				el.title = titler('Valid (Isolated)', [token.cp]);
			} else {
				throw new TypeError(`unknown token type: ${token.type}`);
			}
		}
		return el;
	}));
	return div;
}

export function use_default_style() {
	let style = document.createElement('style');
	style.innerText = `
	.tokens {
		display: flex;
		flex-wrap: wrap;
		gap: 2px;
	}
	.tokens > * {
		padding: 2px 4px;
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.tokens a {
		text-decoration: none;
	}
	.tokens a:hover {
		outline: 2px solid #00f;
	}
	.tokens .valid {
		border-radius: 5px;
		background: #cfc;
		border: 2px solid #0a0;
		line-break: anywhere;
	}
	.tokens .ignored {
		color: #fff;
		background: #aaa;
		min-width: 5px;
		font-size: 70%;
		font-family: monospace;
		border-radius: 5px;
	}
	.tokens .disallowed {
		background: #c00;	
		min-width: 5px;
		border-radius: 5px;
		color: #fff;
	}
	.tokens .disallowed.code {
		font-size: 75%;
		background: #800;
	}
	.tokens .tag sub {
		font-size: 50%;
		color: #ccc;
	}
	.tokens .disallowed.mod {
		border: 2px solid #800;
		font-size: 80%;
	}
	.tokens .mapped {
		display: flex;
		border: 2px solid #66f;
		background: #ccf;
		border-radius: 5px;
	}
	.tokens .mapped span:first-child {
		margin-bottom: -4px;
		border-bottom: 4px solid #000;
	}
	.tokens .stop {
		font-weight: bold;
	}
	.tokens .isolated {
		border: 2px solid #87e;
		border-radius: 5px;
		background: #ecf;
	}
	.tokens .glyph {
		border: 2px solid #0aa;
		border-radius: 5px;
		background: #cff;
	}
	.tokens .mod {
		font-size: 70%;
		padding: 2px;
		color: #fff;
		border-radius: 5px;
	}
	.tokens .glyph .mod {
		background: #333;
	}
	.tokens .glyph .mod.zwj {
		background: #0aa;
	}
	.tokens .glyph .mod.tag {
		background: #0aa;
	}
	.tokens .glyph .mod.tag sub {
		display: none;
	}
	.tokens .glyph .mod.dropped {
		background: #aaa;		
	}
	.tokens .arrow {
		color: rgba(0, 0, 0, 0.35);
	}
	.tokens .code {
		font-family: monospace;
	}
	.tokens .nfc {
		display: flex;
		border: 2px solid #fa0;
		background: #fd8;
		border-radius: 5px;
	}`;
	document.body.append(style);
}