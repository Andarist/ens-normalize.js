function decode_arithmetic(bytes) {
	let pos = 0;
	function u16() { return (bytes[pos++] << 8) | bytes[pos++]; }
	
	// decode the frequency table
	let symbol_count = u16();
	let total = 1;
	let acc = [0, 1]; // first symbol has frequency 1
	for (let i = 1; i < symbol_count; i++) {
		acc.push(total += u16());
	}

	// skip the sized-payload that the last 3 symbols index into
	let skip = u16();
	let pos_payload = pos;
	pos += skip;

	let read_width = 0;
	let read_buffer = 0; 
	function read_bit() {
		if (read_width == 0) {
			// this will read beyond end of buffer
			// but (undefined|0) => zero pad
			read_buffer = (read_buffer << 8) | bytes[pos++];
			read_width = 8;
		}
		return (read_buffer >> --read_width) & 1;
	}

	const N = 31;
	const FULL = 2**N;
	const HALF = FULL >>> 1;
	const QRTR = HALF >> 1;
	const MASK = FULL - 1;

	// fill register
	let register = 0;
	for (let i = 0; i < N; i++) register = (register << 1) | read_bit();

	let symbols = [];
	let low = 0;
	let range = FULL; // treat like a float
	while (true) {
		let value = Math.floor((((register - low + 1) * total) - 1) / range);
		let start = 0;
		let end = symbol_count;
		while (end - start > 1) { // binary search
			let mid = (start + end) >>> 1;
			if (value < acc[mid]) {
				end = mid;
			} else {
				start = mid;
			}
		}
		if (start == 0) break; // first symbol is end mark
		symbols.push(start);
		let a = low + Math.floor(range * acc[start]   / total);
		let b = low + Math.floor(range * acc[start+1] / total) - 1;
		while (((a ^ b) & HALF) == 0) {
			register = (register << 1) & MASK | read_bit();
			a = (a << 1) & MASK;
			b = (b << 1) & MASK | 1;
		}
		while (a & ~b & QRTR) {
			register = (register & HALF) | ((register << 1) & (MASK >>> 1)) | read_bit();
			a = (a << 1) ^ HALF;
			b = ((b ^ HALF) << 1) | HALF | 1;
		}
		low = a;
		range = 1 + b - a;
	}
	let offset = symbol_count - 4;
	return symbols.map(x => { // index into payload
		switch (x - offset) {
			case 3: return offset + 0x10100 + ((bytes[pos_payload++] << 16) | (bytes[pos_payload++] << 8) | bytes[pos_payload++]);
			case 2: return offset + 0x100 + ((bytes[pos_payload++] << 8) | bytes[pos_payload++]);
			case 1: return offset + bytes[pos_payload++];
			default: return x - 1;
		}
	});
}	

// returns an iterator which returns the next symbol
function read_payload(v) {
	let pos = 0;
	return () => v[pos++];
}
function read_compressed_payload(s) {	
	return read_payload(decode_arithmetic(unsafe_atob(s)));
}

// unsafe in the sense:
// expected well-formed Base64 w/o padding 
function unsafe_atob(s) {
	let lookup = [];
	[...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].forEach((c, i) => lookup[c.charCodeAt(0)] = i);
	let n = s.length;
	let ret = new Uint8Array((6 * n) >> 3);
	for (let i = 0, pos = 0, width = 0, carry = 0; i < n; i++) {
		carry = (carry << 6) | lookup[s.charCodeAt(i)];
		width += 6;
		if (width >= 8) {
			ret[pos++] = (carry >> (width -= 8));
		}
	}
	return ret;
}

// eg. [0,1,2,3...] => [0,-1,1,-2,...]
function signed(i) { 
	return (i & 1) ? (~i >> 1) : (i >> 1);
}

function read_counts(n, next) {
	let v = Array(n);
	for (let i = 0; i < n; i++) v[i] = 1 + next();
	return v;
}

function read_ascending(n, next) {
	let v = Array(n);
	for (let i = 0, x = -1; i < n; i++) v[i] = x += 1 + next();
	return v;
}

function read_deltas(n, next) {
	let v = Array(n);
	for (let i = 0, x = 0; i < n; i++) v[i] = x += signed(next());
	return v;
}

// return unsorted? unique array 
function read_member_array(next, lookup) {
	let v = read_ascending(next(), next);
	let n = next();
	let vX = read_ascending(n, next);
	let vN = read_counts(n, next);
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < vN[i]; j++) {
			v.push(vX[i] + j);
		}
	}
	return lookup ? v.map(x => lookup[x]) : v;
}

// returns map of x => ys
function read_mapped(next) {
	let ret = [];
	while (true) {
		let w = next();
		if (w == 0) break;
		ret.push(read_linear_table(w, next));
	}
	while (true) {
		let w = next() - 1;
		if (w < 0) break;
		ret.push(read_replacement_table(w, next));
	}
	return ret.flat();
}

// read until next is falsy
// return array of read values
function read_array_while(next) {
	let v = [];
	while (true) {
		let x = next();
		if (!x) break;
		v.push(x);
	}
	return v;
}

// read w columns of length n
// return as n rows of length w
function read_transposed(n, w, next) {
	let m = Array(n).fill().map(() => []);
	for (let i = 0; i < w; i++) {
		read_deltas(n, next).forEach((x, j) => m[j].push(x));
	}
	return m;
}
 
// returns [[x, ys], [x+dx, ys+dy], [x+2*dx, ys+2*dy], ...]
// where dx/dy = steps, n = run size, w = length of y
function read_linear_table(w, next) {
	let dx = 1 + next();
	let dy = next();
	let vN = read_array_while(next);
	let m = read_transposed(vN.length, 1+w, next);
	return m.flatMap((v, i) => {
		let [x, ...ys] = v;
		return Array(vN[i]).fill().map((_, j) => {
			let j_dy = j * dy;
			return [x + j * dx, ys.map(y => y + j_dy)];
		});
	});
}

// return [[x, ys...], ...]
// where w = length of y
function read_replacement_table(w, next) { 
	let n = 1 + next();
	let m = read_transposed(n, 1+w, next);
	return m.map(v => [v[0], v.slice(1)]);
}

function read_emoji_trie(next) {
	let sorted = read_member_array(next).sort((a, b) => a - b);
	return read();
	function read() {
		let branches = [];
		while (true) {
			let keys = read_member_array(next, sorted);
			if (keys.length == 0) break;
			branches.push({set: new Set(keys), node: read()});
		}
		branches.sort((a, b) => b.set.size - a.set.size); // sort by likelihood
		let temp = next();
		let valid = temp % 3;
		temp = (temp / 3)|0;
		let fe0f = !!(temp & 1);
		temp >>= 1;
		let save = temp == 1;
		let check = temp == 2;
		return {branches, valid, fe0f, save, check};
	}
}

// created 2022-10-03T07:24:35.873Z
var r = read_compressed_payload('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');

function hex_cp(cp) {
	return cp.toString(16).toUpperCase().padStart(2, '0');
}

/*
export function explode_cp(s) {
	return [...s].map(c => c.codePointAt(0));
}
*/
function explode_cp(s) { // this is about 2x faster
	let cps = [];
	for (let pos = 0, len = s.length; pos < len; ) {
		let cp = s.codePointAt(pos);
		pos += cp < 0x10000 ? 1 : 2;
		cps.push(cp);
	}
	return cps;
}

function str_from_cps(cps) {
	return String.fromCodePoint(...cps);
}

// reverse polyfill

function nf(cps, form) {
	return explode_cp(str_from_cps(cps).normalize(form));
}

function nfc(cps) {
	return nf(cps, 'NFC');
}
function nfd(cps) {
	return nf(cps, 'NFD');
}

const SORTED_VALID = read_member_array(r).sort((a, b) => a - b);
const VALID = new Set(SORTED_VALID);
const IGNORED = new Set(read_member_array(r));
const MAPPED = new Map(read_mapped(r));
function read_valid_subset() {
	return new Set(read_member_array(r, SORTED_VALID));
}
const CM = read_valid_subset();
const ISOLATED = read_valid_subset();
const SCRIPTS = ['Latin', 'Greek', 'Cyrillic'].map((k, i) => {
	// this defines the priority
	// order must match make.js
	// note: there are no latin (index = 0) whole-script confusables
	// (script name, script-set, whole-set?)
	return [k, read_valid_subset(), i ? read_valid_subset() : 0]; 
});
const EXCLUDED = read_array_while(() => {
	let v = read_valid_subset();
	if (v.size) return v;
});
const EMOJI_SOLO = new Set(read_member_array(r));
const EMOJI_ROOT = read_emoji_trie(r);
const NFC_CHECK = read_valid_subset();

const STOP = 0x2E;
const HYPHEN = 0x2D;
const UNDERSCORE = 0x5F;
const FE0F = 0xFE0F;

function check_leading_underscore(cps) {
	let i = cps.lastIndexOf(UNDERSCORE);
	while (i > 0) {
		if (cps[--i] !== UNDERSCORE) {
			throw new Error(`underscore only allowed at start`);
		}
	}
}

function check_label_extension(cps) {
	if (cps.length >= 4 && cps[2] === HYPHEN && cps[3] === HYPHEN && cps.every(cp => cp < 0x80)) {
		throw new Error(`invalid label extension`);
	}
}

// check that cp is not touching another cp
// optionally disallow leading/trailing
function check_surrounding(cps, cp, name, no_leading, no_trailing) {
	let last = -1;
	if (cps[0] === cp) {
		if (no_leading) throw new Error(`leading ${name}`);
		last = 0;
	}
	while (true) {
		let i = cps.indexOf(cp, last+1);
		if (i == -1) break;
		if (last == i-1) throw new Error(`adjacent ${name}`);
		last = i;
	}
	if (no_trailing && last == cps.length-1) throw new Error(`trailing ${name}`);
}

// ContextO: MIDDLE DOT
// https://datatracker.ietf.org/doc/html/rfc5892#appendix-A.3
// Between 'l' (U+006C) characters only, used to permit the Catalan character ela geminada to be expressed.
function check_middle_dot(cps) {
	let i = 0;
	while (true) {
		i = cps.indexOf(0xB7, i);
		if (i == -1) break;
		if (cps[i-1] !== 0x6C || cps[i+1] !== 0x6C) throw new Error('ContextO: middle dot');
		i += 2;
	}
}

function check_scripts_latin_like(cps) {
	// https://www.unicode.org/reports/tr39/#mixed_script_confusables
	for (let i = 0; i < SCRIPTS.length; i++) {
		let [name, script_set, whole_set] = SCRIPTS[i];
		if (cps.some(cp => script_set.has(cp))) {
			for (let j = i + 1; j < SCRIPTS.length; j++) { // scripts before already had no match
				let [name_j, set_j] = SCRIPTS[j];
				if (cps.some(cp => set_j.has(cp))) {
					throw new Error(`mixed-script confusable: ${name} + ${name_j}`);
				}
			}
			if (whole_set) { // aka non-latin
				// https://www.unicode.org/reports/tr39/#def_whole_script_confusables
				// if every char matching the script is confusable
				if (cps.every(cp => !script_set.has(cp) || whole_set.has(cp))) {
					throw new Error(`whole-script confusable: ${name}`);
				}
			}
			break;
		}
	}
}

// requires decomposed codepoints
function check_excluded_scripts(cps) {
	// https://www.unicode.org/reports/tr31/#Table_Candidate_Characters_for_Exclusion_from_Identifiers
	for (let set of EXCLUDED) {
		if (cps.some(cp => set.has(cp))) { // first with one match
			if (!cps.every(cp => set.has(cp) || cp == FE0F)) { // must match all (or emoji)
				throw new Error(`excluded script cannot mix`);
			}
			break; // pure
		}
	}
}

// requires decomposed codepoints
function check_combinining_marks(cps) {
	for (let i = 0, j = -1; i < cps.length; i++) {
		if (CM.has(cps[i])) {
			if (i == 0) {
				throw new Error(`leading combining mark`);
			} else if (i == j) {
				throw new Error(`adjacent combining marks "${str_from_cps(cps.slice(i - 2, i + 1))}"`);
			} else {
				let prev = cps[i - 1];
				if (prev == FE0F || ISOLATED.has(prev)) {
					throw new Error(`isolate combining mark`);
				}
			}	
			j = i + 1;
		}
	}
}

// this function only makes sense if the input 
// was an output of ens_normalize_fragment 
function ens_normalize_post_check(norm) {
	for (let label of norm.split('.')) {
		if (!label) throw new Error('Empty label');
		try {
			let cps_nfc = explode_cp(label);
			check_leading_underscore(cps_nfc);
			check_label_extension(cps_nfc);
			check_surrounding(cps_nfc, 0x2019, 'apostrophe', true, true); // question: can this be generalized better?
			check_middle_dot(cps_nfc); // this a lot of effort for 1 character
			check_scripts_latin_like(cps_nfc);
			// replace emoji with single character
			let cps_nfd = nfd(process(label, () => [FE0F])); 
			check_combinining_marks(cps_nfd);
			check_excluded_scripts(cps_nfd); // idea: it's probably safe to early terminate if this is pure
		} catch (err) {
			throw new Error(`Invalid label "${label}": ${err.message}`);
		}
	}
	return norm;
}

function ens_normalize_fragment(frag, nf = nfc) {
	return str_from_cps(nf(process(frag, filter_fe0f)));
}

function ens_normalize(name) {
	return ens_normalize_post_check(ens_normalize_fragment(name));
}

// note: does not post_check
function ens_beautify(name) {
	return str_from_cps(nfc(process(name, x => x)));
}

function filter_fe0f(cps) {
	return cps.filter(cp => cp != FE0F);
}

function process(name, emoji_filter) {
	let input = explode_cp(name).reverse(); // flip so we can pop
	let output = [];
	while (input.length) {
		let emoji = consume_emoji_reversed(input);
		if (emoji) {
			output.push(...emoji_filter(emoji)); // idea: emoji_filter(emoji, output.length); // provide position to callback
		} else {
			let cp = input.pop();
			if (VALID.has(cp)) {
				output.push(cp);
			} else {
				let cps = MAPPED.get(cp);
				if (cps) {
					output.push(...cps);
				} else if (!IGNORED.has(cp)) {
					throw new Error(`Disallowed codepoint: 0x${hex_cp(cp)}`);
				}
			}
		}
	}
	return output;
}

function consume_emoji_reversed(cps, eaten) {
	let node = EMOJI_ROOT;
	let emoji;
	let saved;
	let stack = [];
	let pos = cps.length;
	if (eaten) eaten.length = 0; // clear input buffer (if needed)
	while (pos) {
		let cp = cps[--pos];
		let br = node.branches.find(x => x.set.has(cp));
		if (!br) break;
		node = br.node;
		if (node.save) { // remember
			saved = cp;
		} else if (node.check) { // check exclusion
			if (cp === saved) break;
		}
		stack.push(cp);
		if (node.fe0f) {
			stack.push(FE0F);
			if (pos > 0 && cps[pos - 1] == FE0F) pos--; // consume optional FE0F
		}
		if (node.valid) { // this is a valid emoji (so far)
			emoji = conform_emoji_copy(stack, node);
			if (eaten) eaten.push(...cps.slice(pos).reverse()); // copy input (if needed)
			cps.length = pos; // truncate
		}
	}
	if (!emoji) {
		let cp = cps[cps.length-1];
		if (EMOJI_SOLO.has(cp)) {
			if (eaten) eaten.push(cp);
			emoji = [cp];
			cps.pop();
		}
	}
	return emoji;
}

// create a copy and fix any unicode quirks
function conform_emoji_copy(cps, node) {
	let copy = cps.slice(); // copy stack
	if (node.valid == 2) copy.splice(1, 1); // delete FE0F at position 1 (see: make.js)
	return copy;
}

// return all supported emoji (not sorted)
function ens_emoji() {
	let ret = [...EMOJI_SOLO].map(x => [x]);
	build(EMOJI_ROOT, []);
	return ret;
	function build(node, cps, saved) {
		if (node.save) { // remember
			saved = cps[cps.length-1];
		} else if (node.check) { // check exclusion
			if (saved === cps[cps.length-1]) return;
		}
		if (node.fe0f) cps.push(FE0F);
		if (node.valid) ret.push(conform_emoji_copy(cps, node));
		for (let br of node.branches) {
			for (let cp of br.set) {
				build(br.node, [...cps, cp], saved);
			}
		}
	}
}

// ************************************************************
// tokenizer 

const TY_VALID = 'valid';
const TY_MAPPED = 'mapped';
const TY_IGNORED = 'ignored';
const TY_DISALLOWED = 'disallowed';
const TY_EMOJI = 'emoji';
const TY_ISOLATED = 'isolated';
const TY_NFC = 'nfc';
const TY_STOP = 'stop';

function ens_tokenize(name) {
	let input = explode_cp(name).reverse();
	let eaten = [];
	let tokens = [];
	while (input.length) {		
		let emoji = consume_emoji_reversed(input, eaten);
		if (emoji) {
			tokens.push({type: TY_EMOJI, emoji, input: eaten.slice(), cps: filter_fe0f(emoji)});
		} else {
			let cp = input.pop();
			if (cp === STOP) {
				tokens.push({type: TY_STOP});
			} else if (VALID.has(cp)) {
				if (ISOLATED.has(cp)) {
					tokens.push({type: TY_ISOLATED, cp});
				} else {
					tokens.push({type: TY_VALID, cps: [cp]});
				}
			} else if (IGNORED.has(cp)) {
				tokens.push({type: TY_IGNORED, cp});
			} else {
				let cps = MAPPED.get(cp);
				if (cps) {
					tokens.push({type: TY_MAPPED, cp, cps: cps.slice()});
				} else {
					tokens.push({type: TY_DISALLOWED, cp});
				}
			}
		}
	}
	for (let i = 0, start = -1; i < tokens.length; i++) {
		let token = tokens[i];
		if (is_valid_or_mapped(token.type)) {
			if (requires_check(token.cps)) { // normalization might be needed
				let end = i + 1;
				for (let pos = end; pos < tokens.length; pos++) { // find adjacent text
					let {type, cps} = tokens[pos];
					if (is_valid_or_mapped(type)) {
						if (!requires_check(cps)) break;
						end = pos + 1;
					} else if (type !== TY_IGNORED) { // || type !== TY_DISALLOWED) { 
						break;
					}
				}
				if (start < 0) start = i;
				let slice = tokens.slice(start, end);
				let cps0 = slice.flatMap(x => is_valid_or_mapped(x.type) ? x.cps : []); // strip junk tokens
				let cps = nfc(cps0); // this does extra work for nf-native but oh well
				//if (cps0.length === cps.length && cps0.every((cp, i) => cp === cps[i])) { 
				if (str_from_cps(cps0) === str_from_cps(cps)) {
					i = end - 1; // skip to end of slice
				} else { // bundle into an nfc token
					tokens.splice(start, end - start, {type: TY_NFC, input: cps0, cps, tokens: collapse_valid_tokens(slice)});
					i = start;
				}
				start = -1; // reset
			} else {
				start = i; // remember last
			}
		} else if (token.type === TY_EMOJI) {
			start = -1; // reset
		}
	}
	return collapse_valid_tokens(tokens);
}

function is_valid_or_mapped(type) {
	return type === TY_VALID || type === TY_MAPPED;
}

function requires_check(cps) {
	return cps.some(cp => NFC_CHECK.has(cp));
}

function collapse_valid_tokens(tokens) {
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].type === TY_VALID) {
			let j = i + 1;
			while (j < tokens.length && tokens[j].type === TY_VALID) j++;
			tokens.splice(i, j - i, {type: TY_VALID, cps: tokens.slice(i, j).flatMap(x => x.cps)});
		}
	}
	return tokens;
}

export { ens_beautify, ens_emoji, ens_normalize, ens_normalize_fragment, ens_normalize_post_check, ens_tokenize, nfc, nfd };
