// The local MATLAB functions an exported script may call (placed at the end of the script, as MATLAB requires).
// OWNER: export agent.
//
// readXPlaneLog mirrors the app parser's acceptance rule (core/parse/streaming.ts, rules 1–7) and xppElapsed mirrors
// core/time.ts buildElapsed, so the script sees the same rows and the same elapsed time as the app. Change them
// together with those modules. Everything here is base MATLAB (R2021a+).

interface LibraryFunction {
  name: string
  /** Other library functions this one calls */
  deps: string[]
  code: string
}

const READER = String.raw`function [D, names] = readXPlaneLog(file)
%READXPLANELOG Read an X-Plane "Data.txt" log, keeping exactly the rows X-Plane Plotter keeps.
%   [D, names] = readXPlaneLog(file) returns D (one row per accepted data line, one column per header cell;
%   NaN where a cell is empty, text, a nan/inf spelling or infinite) and names (1 x columns cell array of the
%   header cells, repeated tokens included). The rules are the app parser's (src/core/parse/streaming.ts):
%   1. Lines end at "\n" (one "\r" before it is dropped). Blank characters are space, tab and NUL (a log cut off
%      by a power loss can end in NUL bytes); lines of only blanks are ignored.
%   2. The header is the first non-blank line not starting with "#". X-Plane logs separate cells with "|": the
%      header has two or more, or ends with one (other text tables: TAB if the header has one, else the more
%      frequent of ";" and ",", with "double quotes" around cells; text in quotes never counts).
%   3. Cells are split at the delimiter and trimmed of blanks; an empty last cell (X-Plane ends lines with "| ")
%      is dropped.
%   4. A cell is a number as JavaScript's Number() reads it; anything else is NaN.
%   5. A header-like line (some cell is text, none is a number or a nan/inf spelling) equal to the header is
%      skipped; a different one of X-Plane column names ("_Vind,_kias") ends the table, or replaces the header if
%      no data row came before it. Any other header-like line (a typed note, garbled bytes) is skipped.
%   6. A data line is kept if it has exactly numel(names) cells (other tables: and at least one number).
%   7. A last line without "\n" is dropped if it has fewer cells than the header or does not end with "|".
%   Fast on large logs: the plain numeric lines (all of them in a normal log) are converted by one sscanf call.
txt = fileread(file);
if startsWith(txt, char(65279))                          % UTF-8 byte-order mark, decoded ...
    txt = txt(2:end);
elseif startsWith(txt, char([239 187 191]))              % ... or read as single bytes
    txt = txt(4:end);
end
terminated = ~isempty(txt) && txt(end) == newline;
txt = strrep(txt, [char(13) newline], newline);          % one "\r" per line ending
if ~terminated && endsWith(txt, char(13))
    txt(end) = [];
end
lines = regexp(txt, '\n', 'split')';
blank = cellfun('isempty', regexp(lines, ['[^ \t' char(0) ']'], 'once'));

% Rule 2: the header line and the delimiter.
h = 0;
for i = reshape(find(~blank), 1, [])
    s = lines{i};
    if s(find(s ~= ' ' & s ~= char(9) & s ~= char(0), 1)) ~= '#'
        h = i;
        break
    end
end
if h == 0
    error('xpp:noHeader', 'No header line in %s.', file);
end
bare = regexprep(lines{h}, '"[^"]*("|$)', '"');          % text in quotes does not count (to the end if unclosed)
xplane = count(bare, '|') >= 2 || endsWith(regexprep(bare, ['[ \t' char(0) ']+$'], ''), '|');
if xplane
    delim = '|';
elseif contains(bare, char(9))
    delim = char(9);
elseif count(bare, ';') > 0 && count(bare, ';') >= count(bare, ',')
    delim = ';';
else
    delim = ',';
end
decimalComma = delim == ';';
headerCells = xppNormalize(xppSplitCells(lines{h}, delim, ~xplane));
dropTrailing = xplane;
if numel(headerCells) > 1 && isempty(headerCells{end})
    headerCells(end) = [];
    dropTrailing = true;
end
[~, kinds] = xppCellValues(headerCells, decimalComma);
if xplane && ~any(kinds == 3)
    error('xpp:noHeader', 'No header line in %s: its first line holds no column names.', file);
end
headerless = ~xplane && ~any(kinds == 3) && any(kinds == 1);
names = xppNames(headerCells, headerless);
if headerless
    headerCells = {};                                    % that line is the first data row
end
nCols = numel(names);

% The other non-blank lines and their cell counts (rule 3).
lineNo = find(~blank);
lineNo = lineNo(lineNo > h | (headerless & lineNo == h));
B = lines(lineNo);
nB = numel(B);
if delim == char(9)
    blanks = [' ' char(0)];
else
    blanks = [' ' char(9) char(0)];
end
endsDelim = endsWith(B, {[delim ' '], delim});
other = find(~endsDelim);
endsDelim(other) = ~cellfun('isempty', regexp(B(other), [regexptranslate('escape', delim) '[' blanks ']*$'], 'once'));
nCells = count(B, delim) + 1 - (dropTrailing & endsDelim);

% Lines holding anything but plain numbers are read cell by cell: a character other than digits . + -, blanks and
% the delimiter (letters, nan, quotes...), or an empty cell (two delimiters with only blanks between them, or a
% line starting with one). Found for every line at once in the joined text, which sscanf then reads.
joined = strjoin(B', newline);
starts = [0, find(joined == newline)] + 1;               % first character of each line in "joined"
odd = find(~ismember(joined, ['0123456789.+-' delim blanks newline]));
squeezed = joined(~ismember(joined, blanks));
cuts = [0, find(squeezed == newline)] + 1;
empty = [strfind(squeezed, [delim delim]), strfind(squeezed, [newline delim]) + 1];
if startsWith(squeezed, delim)
    empty(end + 1) = 1;
end
special = false(nB, 1);
special(discretize(odd, [starts, numel(joined) + 2])) = true;
special(discretize(empty, [cuts, numel(squeezed) + 2])) = true;
values = cell(nB, 1);
headerLike = false(nB, 1);
hasNumber = true(nB, 1);
for j = reshape(find(special), 1, [])
    [values{j}, nCells(j), headerLike(j), hasNumber(j)] = ...
        xppParseLine(B{j}, delim, ~xplane, dropTrailing, decimalComma);
end
% The plain lines in one sscanf call. Each cell must give exactly one number; if the total is off, some cell
% is not a number (e.g. "1.2.3" or "-"), and the plain lines are checked one by one.
plain = find(~special);
flat = [];
offset = [];
if ~isempty(plain)
    if numel(plain) < nB
        joined = strjoin(B(plain)', newline);
    end
    joined(joined == delim | joined == char(0)) = ' ';
    flat = sscanf(joined, '%f');
    offset = cumsum([0; nCells(plain)]);
    if numel(flat) ~= offset(end)
        for j = reshape(plain, 1, [])
            v = sscanf(strrep(B{j}, delim, ' '), '%f');
            if numel(v) == nCells(j)
                values{j} = v';
            else
                [values{j}, nCells(j), headerLike(j), hasNumber(j)] = ...
                    xppParseLine(B{j}, delim, ~xplane, dropTrailing, decimalComma);
            end
        end
        special(plain) = true;                           % their values are in "values" now
        plain = [];
    end
end

% Rule 5: repeated headers are skipped; a new X-Plane header ends the table, or replaces the header before data.
skip = false(nB, 1);
first = 1;
stop = nB + 1;
for j = reshape(find(headerLike), 1, [])
    cells = xppNormalize(xppSplitCells(B{j}, delim, ~xplane));
    if dropTrailing && numel(cells) > 1 && isempty(cells{end})
        cells(end) = [];
    end
    if isequal(cells, headerCells)
        skip(j) = true;
    elseif xplane
        filled = cells(~cellfun('isempty', cells));
        shaped = ~cellfun('isempty', regexp(filled, '^[^, ]+,[^, ]+', 'once'));
        if ~contains(B{j}, '|') || 2 * nnz(shaped) <= numel(filled)
            continue                                     % a typed note or garbled bytes: never a data row
        end
        earlier = first:j - 1;
        if any(nCells(earlier) == nCols & ~headerLike(earlier))
            stop = j;                                    % the Data Output selection changed: first table only
            break
        end
        headerCells = cells;                             % no data yet: the new header replaces the old one
        names = xppNames(cells, false);
        nCols = numel(names);
        skip(j) = true;
        first = j + 1;
    end
end

% Rules 6 and 7, then the values of the kept rows.
k = (1:nB)';
incomplete = lineNo == numel(lines) & ~terminated & (nCells < nCols | (xplane & ~endsDelim));
keep = k >= first & k < stop & ~skip & ~headerLike & nCells == nCols & ~incomplete & (xplane | hasNumber);
rows = find(keep);
if isequal(rows, plain)
    D = reshape(flat, nCols, [])';                       % the usual case: every kept line is plain
else
    D = NaN(numel(rows), nCols);
    fromFlat = ~special(rows);
    if any(fromFlat)
        [~, at] = ismember(rows(fromFlat), plain);
        D(fromFlat, :) = flat(offset(at) + (1:nCols));
    end
    for r = reshape(find(~fromFlat), 1, [])
        D(r, :) = values{rows(r)}(1:nCols);
    end
end
D(~isfinite(D)) = NaN;                                   % the app stores infinities as NaN
end`

const READER_HELPERS: LibraryFunction[] = [
  {
    name: 'xppParseLine',
    deps: ['xppSplitCells', 'xppCellValues'],
    code: String.raw`function [v, n, headerLike, hasNumber] = xppParseLine(line, delim, quoting, dropTrailing, decimalComma)
%XPPPARSELINE One line read cell by cell: values, number of cells, header-like?, any number?
cells = xppSplitCells(line, delim, quoting);
if dropTrailing && numel(cells) > 1 && all(cells{end} == ' ' | cells{end} == char(9) | cells{end} == char(0))
    cells(end) = [];
end
[v, kinds] = xppCellValues(cells, decimalComma);
n = numel(cells);
headerLike = any(kinds == 3) && ~any(kinds == 1 | kinds == 2);
hasNumber = any(kinds == 1);
end`,
  },
  {
    name: 'xppSplitCells',
    deps: ['xppSplitQuoted'],
    code: String.raw`function cells = xppSplitCells(line, delim, quoting)
%XPPSPLITCELLS The raw cells of a line (RFC 4180 quotes are honoured in text tables).
if quoting && contains(line, '"')
    cells = xppSplitQuoted(line, delim);
else
    cells = strsplit(line, delim, 'CollapseDelimiters', false);
end
end`,
  },
  {
    name: 'xppSplitQuoted',
    deps: [],
    code: String.raw`function cells = xppSplitQuoted(line, delim)
%XPPSPLITQUOTED Cells of a CSV line: a cell starting with a double quote runs to the matching quote ("" is one
%   quote, text after the closing quote up to the delimiter is kept); an unclosed quote runs to the end.
cells = {};
n = numel(line);
i = 1;
while true
    j = i;
    while j <= n && (line(j) == ' ' || line(j) == char(0) || (line(j) == char(9) && delim ~= char(9)))
        j = j + 1;
    end
    if j <= n && line(j) == '"'
        value = '';
        k = j + 1;
        while true
            q = find(line(k:end) == '"', 1) + k - 1;
            if isempty(q)
                value = [value line(k:end)]; %#ok<AGROW>
                k = n + 1;
                break
            elseif q < n && line(q + 1) == '"'
                value = [value line(k:q)]; %#ok<AGROW>
                k = q + 2;
            else
                value = [value line(k:q - 1)]; %#ok<AGROW>
                k = q + 1;
                break
            end
        end
        stopAt = find(line(k:end) == delim, 1) + k - 1;
        if isempty(stopAt)
            cells{end + 1} = [value line(k:end)]; %#ok<AGROW>
            return
        end
        cells{end + 1} = [value line(k:stopAt - 1)]; %#ok<AGROW>
    else
        stopAt = find(line(i:end) == delim, 1) + i - 1;
        if isempty(stopAt)
            cells{end + 1} = line(i:end); %#ok<AGROW>
            return
        end
        cells{end + 1} = line(i:stopAt - 1); %#ok<AGROW>
    end
    i = stopAt + 1;
end
end`,
  },
  {
    name: 'xppCellValues',
    deps: [],
    code: String.raw`function [v, kinds] = xppCellValues(cells, decimalComma)
%XPPCELLVALUES Cell values as JavaScript's Number() reads them, with each cell's kind:
%   0 empty, 1 number, 2 nan/inf spelling or infinite, 3 text. Only finite numbers keep a value (others NaN).
n = numel(cells);
v = NaN(1, n);
kinds = 3 * ones(1, n);
for k = 1:n
    s = regexprep(cells{k}, ['^[\s' char(0) ']+|[\s' char(0) ']+$'], '');   % trimmed of white space and NUL
    if isempty(s)
        kinds(k) = 0;
        continue
    end
    if decimalComma
        s(find(s == ',', 1)) = '.';
    end
    x = NaN;
    if ~isempty(regexp(s, '^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$', 'once'))
        x = str2double(s);
    elseif ~isempty(regexp(s, '^0[xX][0-9a-fA-F]+$', 'once'))
        x = hex2dec(s(3:end));
    elseif ~isempty(regexp(s, '^0[bB][01]+$', 'once'))
        x = bin2dec(s(3:end));
    elseif ~isempty(regexp(s, '^0[oO][0-7]+$', 'once'))
        x = base2dec(s(3:end), 8);
    elseif any(strcmp(s, {'Infinity', '+Infinity', '-Infinity'}))
        x = Inf;
    end
    if isfinite(x)
        v(k) = x;
        kinds(k) = 1;
    elseif isinf(x) || ~isempty(regexpi(s, '^[+-]?(nan|inf(inity)?|1\.#(inf|ind|qnan|snan)0*)(\([\w ]*\))?$', 'once'))
        kinds(k) = 2;
    end
end
end`,
  },
  {
    name: 'xppNormalize',
    deps: [],
    code: String.raw`function cells = xppNormalize(cells)
%XPPNORMALIZE Header cells as the app compares them: each run of white space or NUL as one space, trimmed.
cells = strtrim(regexprep(cells, ['[\s' char(0) ']+'], ' '));
end`,
  },
  {
    name: 'xppNames',
    deps: [],
    code: String.raw`function names = xppNames(cells, headerless)
%XPPNAMES Column names: the header cells, with "Column k" for empty ones (or for all, without a header).
names = cells;
for k = 1:numel(cells)
    if headerless || isempty(cells{k})
        names{k} = sprintf('Column %d', k);
    end
end
end`,
  },
]

const LIBRARY: LibraryFunction[] = [
  {
    name: 'readXPlaneLog',
    deps: ['xppParseLine', 'xppSplitCells', 'xppCellValues', 'xppNormalize', 'xppNames'],
    code: READER,
  },
  ...READER_HELPERS,
  {
    name: 'xppColumn',
    deps: [],
    code: String.raw`function c = xppColumn(names, token, occurrence)
%XPPCOLUMN Column of the occurrence-th header cell equal to token (X-Plane repeats some tokens).
c = find(strcmp(names, token), occurrence);
if numel(c) < occurrence
    error('xpp:noColumn', ['The log has no column "%s" (occurrence %d). Is dataFile the log this script ' ...
        'was exported from?'], token, occurrence);
end
c = c(occurrence);
end`,
  },
  {
    name: 'xppElapsed',
    deps: [],
    code: String.raw`function [el, dt, segStart] = xppElapsed(t)
%XPPELAPSED Elapsed time (s) from a raw time column, exactly as X-Plane Plotter builds it (src/core/time.ts).
%   dt is the median positive step between adjacent rows. Within a segment, elapsed = base + (t - t_base) and
%   never decreases. A step backwards (sim reset) or forwards by more than max(1 s, 20*dt) beyond the rows
%   bridged (recording gap) starts a new segment and advances the clock by dt; so does every row without a time
%   value. segStart is the first row of each segment.
t = t(:);
n = numel(t);
el = zeros(n, 1);
segStart = 1;
steps = diff(t);
dt = median(steps(steps > 0 & steps < Inf));
step = dt;
if isnan(step)
    step = 0;
end
gapLimit = max(1, 20 * step);
lastRow = 0;                                             % row of the previous time value (0: none yet)
lastValue = NaN;
baseValue = NaN;
baseElapsed = 0;
for i = 1:n
    previous = 0;
    if i > 1
        previous = el(i - 1);
    end
    value = t(i);
    if ~isfinite(value)
        el(i) = previous + step * (i > 1);
        continue
    end
    if lastRow > 0
        delta = value - lastValue;
        bridged = (i - lastRow - 1) * step;
        if delta >= 0 && delta - bridged <= gapLimit
            el(i) = max(previous, baseElapsed + (value - baseValue));
            lastRow = i;
            lastValue = value;
            continue
        end
        segStart(end + 1, 1) = i; %#ok<AGROW>
    end
    el(i) = previous + step * (i > 1);
    baseValue = value;
    baseElapsed = el(i);
    lastRow = i;
    lastValue = value;
end
end`,
  },
  {
    name: 'xppRows',
    deps: [],
    code: String.raw`function rows = xppRows(el, first, last, t0, t1, what)
%XPPROWS Rows first:last (1-based, inclusive), checked against the elapsed times the app had there (t0, t1).
%   If they do not match (another or an edited log), the window is located by elapsed time instead.
tolerance = 1e-3;
if first >= 1 && last <= numel(el) && first <= last && abs(el(first) - t0) <= tolerance ...
        && abs(el(last) - t1) <= tolerance
    rows = (first:last)';
    return
end
rows = find(el >= t0 - tolerance & el <= t1 + tolerance);
warning('xpp:rows', ['Rows %d-%d of this log do not match %s in the app (elapsed %.3f-%.3f s); using ' ...
    'the %d rows found by elapsed time instead.'], first, last, what, t0, t1, numel(rows));
end`,
  },
  {
    name: 'xppStats',
    deps: ['xppUnwrapDegrees'],
    code: String.raw`function s = xppStats(x, isHeading)
%XPPSTATS [mean, std, min, max, n] of the finite samples of x (std: sample standard deviation, n - 1).
%   isHeading true: x is a direction in degrees that wraps at north (heading, track, wind direction), so, as in the
%   app (core/analysis/windowStats.ts), the window is unwrapped first and a turn through 360/0 deg reads as a turn,
%   not as a 180 deg average with a huge spread. The mean is then given in 0-360 deg, and min and max move with it.
heading = nargin > 1 && isHeading;
if heading
    x = xppUnwrapDegrees(x);
end
x = x(isfinite(x));
if isempty(x)
    s = [NaN, NaN, NaN, NaN, 0];
    return
end
s = [mean(x), std(x), min(x), max(x), numel(x)];
if heading
    shift = mod(s(1), 360) - s(1);
    s([1 3 4]) = s([1 3 4]) + shift;
end
end`,
  },
  {
    name: 'xppUnwrapDegrees',
    deps: [],
    code: String.raw`function u = xppUnwrapDegrees(x)
%XPPUNWRAPDEGREES x (degrees) with the 0/360 wraps taken out, exactly as the app does: +/-360 wherever consecutive
%   finite samples jump by more than 180 deg. Samples without a value stay NaN and do not break the run.
u = x(:);
offset = 0;
previous = NaN;
for k = 1:numel(u)
    if ~isfinite(u(k))
        u(k) = NaN;
        continue
    end
    value = u(k) + offset;
    if isfinite(previous)
        while value - previous > 180
            offset = offset - 360;
            value = value - 360;
        end
        while value - previous < -180
            offset = offset + 360;
            value = value + 360;
        end
    end
    u(k) = value;
    previous = value;
end
end`,
  },
  {
    name: 'xppFigure',
    deps: [],
    code: String.raw`function fig = xppFigure(show, name, sizeCm)
%XPPFIGURE A new white figure of the given size (cm), on screen or off-screen.
visible = 'off';
if show
    visible = 'on';
end
fig = figure('Name', name, 'NumberTitle', 'off', 'Color', 'w', 'Visible', visible, 'Units', 'centimeters');
fig.Position(3:4) = sizeCm;
if ~isMATLABReleaseOlderThan('R2025a')
    theme(fig, 'light');                                 % keep the white paper look with a dark desktop theme
end
end`,
  },
  {
    name: 'xppExport',
    deps: [],
    code: String.raw`function xppExport(fig, file, show)
%XPPEXPORT Saves a figure as file.png (300 dpi) and file.pdf (vector), then closes it unless figures are shown.
%   The axes toolbars are hidden first: a figure on screen shows one while the pointer is over it, and it must never
%   end up in the files.
for exportAxes = reshape(findall(fig, 'Type', 'axes'), 1, [])
    exportAxes.Toolbar.Visible = 'off';
end
exportgraphics(fig, [file '.png'], 'Resolution', 300, 'BackgroundColor', 'white');
exportgraphics(fig, [file '.pdf'], 'ContentType', 'vector', 'BackgroundColor', 'white');
fprintf('Saved %s.png and %s.pdf\n', file, file);
if ~show
    close(fig);
end
end`,
  },
  {
    name: 'xppSamples',
    deps: [],
    code: String.raw`function xppSamples(ax, x, y, rows, style, colorBy, color, el, name, inLegend)
%XPPSAMPLES Draws y(rows) against x(rows) as dots, lines or both (lines break between separate windows), or as
%   dots coloured by elapsed time when colorBy is 'time'.
shown = 'off';
if inLegend
    shown = 'on';
end
if strcmp(colorBy, 'time')
    scatter(ax, x(rows), y(rows), 6, el(rows), 'filled', 'DisplayName', name, 'HandleVisibility', shown);
    return
end
rows = rows(:);
xs = x(rows);
ys = y(rows);
if ~strcmp(style, 'points')
    gap = [false; diff(rows) ~= 1];
    slot = (1:numel(rows))' + cumsum(gap);
    xs = NaN(numel(rows) + sum(gap), 1);
    ys = xs;
    xs(slot) = x(rows);
    ys(slot) = y(rows);
end
switch style
    case 'lines'
        spec = '-';
    case 'both'
        spec = '.-';
    otherwise
        spec = '.';
end
plot(ax, xs, ys, spec, 'Color', color, 'MarkerSize', 6, 'LineWidth', 1, 'DisplayName', name, ...
    'HandleVisibility', shown);
end`,
  },
  {
    name: 'xppPolyFit',
    deps: ['xppUnscale', 'xppPolyText'],
    code: String.raw`function [xs, ys, equation, coeffs, r2] = xppPolyFit(x, y, degree)
%XPPPOLYFIT Least-squares polynomial through the finite (x, y) pairs, with its equation and R^2.
%   xs, ys sample the curve over the data's x range (empty when there are not enough distinct x values); coeffs
%   are in x itself, highest power first (polyfit centres and scales x internally for accuracy).
ok = isfinite(x) & isfinite(y);
x = x(ok);
y = y(ok);
xs = [];
ys = [];
equation = '';
coeffs = [];
r2 = NaN;
if numel(unique(x)) <= degree
    return
end
[p, ~, mu] = polyfit(x, y, degree);
coeffs = xppUnscale(p, mu);
residual = y - polyval(p, x, [], mu);
r2 = 1 - sum(residual .^ 2) / sum((y - mean(y)) .^ 2);
xs = linspace(min(x), max(x), 200)';
ys = polyval(p, xs, [], mu);
equation = sprintf('%s  (R%s = %.4f, n = %d)', xppPolyText(coeffs), char(178), r2, numel(x));
end`,
  },
  {
    name: 'xppUnscale',
    deps: [],
    code: String.raw`function c = xppUnscale(p, mu)
%XPPUNSCALE Coefficients in x of the polynomial polyfit returned for z = (x - mu(1)) / mu(2).
z = [1 / mu(2), -mu(1) / mu(2)];
c = p(1);
for j = 2:numel(p)
    c = conv(c, z);
    c(end) = c(end) + p(j);
end
end`,
  },
  {
    name: 'xppPolyText',
    deps: [],
    code: String.raw`function s = xppPolyText(c)
%XPPPOLYTEXT "y = 0.1053*x + 0.2271" style text (4 significant figures) for coefficients, highest power first.
degree = numel(c) - 1;
s = 'y =';
for j = 1:numel(c)
    power = degree - j + 1;
    if j == 1
        s = sprintf('%s %.4g', s, c(j));
    elseif c(j) < 0
        s = sprintf('%s - %.4g', s, -c(j));
    else
        s = sprintf('%s + %.4g', s, c(j));
    end
    if power >= 1
        s = [s char(183) 'x']; %#ok<AGROW>
    end
    if power >= 2
        s = [s char(176 + power)]; %#ok<AGROW> (char 178/179: superscript 2/3)
    end
end
end`,
  },
  {
    name: 'xppOnAxes',
    deps: [],
    code: String.raw`function [keep, outside] = xppOnAxes(x, y, rows, xLimits, yLimits)
%XPPONAXES The rows whose (x, y) lie inside the axis ranges the app showed ([] = no limit on that axis), and the
%   number of samples with values left out. Like the app, a fit through the samples keeps to its axes, so a few
%   absurd values (CL on the ground at zero airspeed) cannot swamp it.
rows = rows(:);
xs = x(rows);
ys = y(rows);
inside = true(size(rows));
if ~isempty(xLimits)
    inside = inside & xs >= xLimits(1) & xs <= xLimits(2);
end
if ~isempty(yLimits)
    inside = inside & ys >= yLimits(1) & ys <= yLimits(2);
end
keep = rows(inside);
outside = sum(~inside & isfinite(xs) & isfinite(ys));
end`,
  },
  {
    name: 'xppFitCurve',
    deps: ['xppPolyFit', 'xppPhysicalFit'],
    code: String.raw`function f = xppFitCurve(x, y, model, degree)
%XPPFITCURVE The app's fit of y against x: a polynomial of the given degree (model 'poly', xppPolyFit), or a physical
%   model of the parabolic drag polar through the points at x > 0 (xppPhysicalFit): 'power' y = A*V^3 + B/V, 'drag'
%   y = A*V^2 + B/V^2. f.ok is false with too few distinct x values; f.xs, f.ys sample the curve over the fitted x
%   range and f.equation is its text with R^2 and n.
x = x(:);
y = y(:);
ok = isfinite(x) & isfinite(y);
if ~strcmp(model, 'poly')
    ok = ok & x > 0;
end
x = x(ok);
y = y(ok);
f = struct('model', model, 'degree', degree, 'ok', false, 'n', numel(x), 'xMin', min([x; Inf]), ...
    'xMax', max([x; -Inf]), 'coeffs', [], 'a', NaN, 'b', NaN, 'aSe', NaN, 'bSe', NaN, 'r2', NaN, 'rmse', NaN, ...
    'xs', [], 'ys', [], 'equation', '');
if strcmp(model, 'poly')
    [f.xs, f.ys, f.equation, f.coeffs, f.r2] = xppPolyFit(x, y, degree);
    f.ok = ~isempty(f.xs);
    if f.ok
        f.rmse = sqrt(mean((y - polyval(f.coeffs, x)) .^ 2));
    end
else
    f = xppPhysicalFit(x, y, f);
end
end`,
  },
  {
    name: 'xppPhysicalFit',
    deps: [],
    code: String.raw`function f = xppPhysicalFit(v, y, f)
%XPPPHYSICALFIT Least squares of y = A*V^p + B*V^q (f.model 'power': p = 3, q = -1; 'drag': p = 2, q = -2), linear in
%   A and B, solved as the app solves it: QR on the columns [u^p, u^q] with u = V / sqrt(min(V) * max(V)), so both
%   columns are of order one. Standard errors from s^2 * inv(M' * M), s^2 = SSR / (n - 2). Needs 2 distinct speeds.
if numel(unique(v)) < 2
    return
end
p = 3;
q = -1;
if strcmp(f.model, 'drag')
    p = 2;
    q = -2;
end
ref = sqrt(min(v) * max(v));
u = v / ref;
M = [u .^ p, u .^ q];
[Q, R] = qr(M, 0);
c = R \ (Q' * y);
ssr = sum((y - M * c) .^ 2);
n = numel(v);
f.a = c(1) / ref ^ p;
f.b = c(2) / ref ^ q;
sst = sum((y - mean(y)) .^ 2);
if sst > n * (1e-14 * max(abs(y))) ^ 2
    f.r2 = 1 - ssr / sst;                                % no R^2 (NaN) when y does not vary
end
f.rmse = sqrt(ssr / n);
if n > 2
    Rinv = R \ eye(2);
    covariance = ssr / (n - 2) * (Rinv * Rinv');
    f.aSe = sqrt(covariance(1, 1)) / ref ^ p;
    f.bSe = sqrt(covariance(2, 2)) / ref ^ q;
end
f.ok = true;
f.xs = linspace(f.xMin, f.xMax, 200)';
f.ys = f.a * f.xs .^ p + f.b * f.xs .^ q;
power = char(179);                                       % superscript 3
denominator = 'x';
if p == 2
    power = char(178);                                   % superscript 2
    denominator = ['x' char(178)];
end
sign = '+';
if f.b < 0
    sign = '-';
end
f.equation = sprintf('y = %.4g%sx%s %s %.4g/%s  (R%s = %.4f, n = %d)', f.a, char(183), power, sign, abs(f.b), ...
    denominator, char(178), f.r2, n);
end`,
  },
  {
    name: 'xppCurveValue',
    deps: [],
    code: String.raw`function y = xppCurveValue(f, v)
%XPPCURVEVALUE The fitted curve f (xppFitCurve) at the speeds v.
if strcmp(f.model, 'poly')
    y = polyval(f.coeffs, v);
elseif strcmp(f.model, 'power')
    y = f.a * v .^ 3 + f.b * v .^ -1;
else
    y = f.a * v .^ 2 + f.b * v .^ -2;
end
end`,
  },
  {
    name: 'xppDrawFit',
    deps: [],
    code: String.raw`function fitLog = xppDrawFit(ax, f, label, color, outside, fitLog, dotted)
%XPPDRAWFIT Draws a fitted curve from xppFitCurve and adds its equation to fitLog (or why there is no fit); outside is
%   the number of samples left out because they lie off the axes. dotted: with the range and endurance constructions,
%   as in the app; the legend then names the model only (the equation is in fitLog and out/range_endurance.txt).
if ~f.ok
    fitLog{end + 1} = sprintf('%s: not enough distinct x values for the fit', label);
    return
end
style = '-';
name = [label ' fit: ' f.equation];
if dotted
    style = ':';
    switch f.model
        case 'power'
            short = ['A' char(183) 'V' char(179) ' + B/V'];
        case 'drag'
            short = ['A' char(183) 'V' char(178) ' + B/V' char(178)];
        otherwise
            degrees = {'linear', 'quadratic', 'cubic'};
            short = degrees{min(max(f.degree, 1), 3)};
    end
    name = [label ' fit: ' short];
end
plot(ax, f.xs, f.ys, style, 'Color', color, 'LineWidth', 1.5, 'DisplayName', name);
note = '';
if outside > 0
    note = sprintf(' [%d samples off the axes left out, as in the app]', outside);
end
fitLog{end + 1} = [label ': ' f.equation note];
end`,
  },
  {
    name: 'xppRangeEndurance',
    deps: ['xppInteriorMin', 'xppBisect', 'xppCurveValue'],
    code: String.raw`function re = xppRangeEndurance(f)
%XPPRANGEENDURANCE Maximum endurance V_E (the minimum of the fitted curve) and maximum range V_R (where the tangent from
%   the origin touches it), found exactly as the app finds them (src/core/analysis/rangeEndurance.ts):
%   - physical models in closed form: power V_E = (B/3A)^(1/4), V_R = (B/A)^(1/4); drag V_E = (B/A)^(1/4),
%     V_R = (3B/A)^(1/4), so V_R/V_E = 3^(1/4) for both. Only when A > 0 and B > 0, R^2 > 0, and A and B are each
%     at least two standard errors above zero: otherwise the note says why there are no speeds;
%   - polynomials by a scan of 2001 speeds, then bisection on f' (minimum) and on V*f' - f (tangent) to full precision.
%   Both search the fitted speed range widened by half its span on each side; a point outside it is not reported (the
%   note says why). Points outside the fitted speeds are flagged as extrapolated.
re = struct('vE', NaN, 'yE', NaN, 'vR', NaN, 'yR', NaN, 'extrapE', false, 'extrapR', false, 'slope', NaN, ...
    'ratio', NaN, 'noteE', '', 'noteR', '', 'window', [NaN NaN]);
if ~f.ok
    re.noteE = 'No fit.';
    re.noteR = re.noteE;
    return
end
if ~(f.xMax > 0)
    re.noteE = 'Needs test points at positive speeds.';
    re.noteR = re.noteE;
    return
end
margin = 0.5 * (f.xMax - f.xMin);
floorSpeed = 1e-3 * f.xMax;
if f.xMin > 0
    floorSpeed = 0.1 * f.xMin;
end
lo = max(f.xMin - margin, floorSpeed);
hi = f.xMax + margin;
re.window = [lo hi];
if strcmp(f.model, 'poly')
    c = f.coeffs;                                        % highest power first
    if numel(c) < 3 || all(c(1:end - 2) == 0)
        re.noteE = 'A straight line has neither a minimum nor a tangent from the origin: fit a curve.';
        re.noteR = re.noteE;
        return
    end
    n = 2000;
    vs = lo + (hi - lo) * (0:n)' / n;
    fv = polyval(c, vs);
    i = xppInteriorMin(fv);
    if i > 0
        re.vE = xppBisect(polyder(c), vs(i - 1), vs(i + 1), vs(i));
        re.yE = polyval(c, re.vE);
    else
        re.noteE = sprintf('No minimum between %.4g and %.4g: the fitted curve keeps falling or rising there.', lo, hi);
    end
    i = xppInteriorMin(fv ./ vs);
    re.noteR = sprintf('No tangent from the origin touches the fitted curve between %.4g and %.4g.', lo, hi);
    if i > 0
        tangent = c .* ((numel(c) - 1:-1:0) - 1);       % V*f'(V) - f(V): coefficient (k - 1)*c_k of V^k
        v = xppBisect(tangent, vs(i - 1), vs(i + 1), vs(i));
        y = polyval(c, v);
        if y > 0
            re.vR = v;
            re.yR = y;
            re.noteR = '';
        else
            re.noteR = 'The tangent from the origin would touch the curve where it is not positive.';
        end
    end
else
    a = f.a;
    b = f.b;
    shape = 'A*V^3 + B/V';
    least = 'power';
    if strcmp(f.model, 'drag')
        shape = 'A*V^2 + B/V^2';
        least = 'drag';
    end
    if ~(a > 0) || ~(b > 0)
        re.noteE = sprintf(['No minimum: %s has one only when A and B are both positive (here A = %.4g, B = %.4g). ' ...
            'Test points on both sides of the minimum-%s speed fix that.'], shape, a, b, least);
    elseif isnan(f.r2)
        re.noteE = 'No minimum: y does not vary across these points, so the model has no curve to read the speeds from.';
    elseif ~(f.r2 > 0)
        re.noteE = sprintf(['No minimum: the model does not fit these points (R^2 = %.3f), so neither speed can be ' ...
            'read from it. Fit it through the means of steady level test points.'], f.r2);
    elseif a < 2 * f.aSe || b < 2 * f.bSe                % NaN standard errors (two points) never count here
        weak = {'A', 'B', 'A and B'};
        verb = {'is', 'is', 'are'};
        pick = (a < 2 * f.aSe) + 2 * (b < 2 * f.bSe);
        re.noteE = sprintf(['No minimum: %s %s within two standard errors of zero (A = %.4g +/- %.4g, B = %.4g +/- ' ...
            '%.4g), so the minimum could be almost anywhere. Test points on both sides of the minimum-%s speed fix ' ...
            'that.'], weak{pick}, verb{pick}, a, f.aSe, b, f.bSe, least);
    end
    if ~isempty(re.noteE)
        re.noteR = re.noteE;
        return
    end
    if strcmp(f.model, 'power')
        vE = (b / (3 * a)) ^ 0.25;
        vR = (b / a) ^ 0.25;
    else
        vE = (b / a) ^ 0.25;
        vR = (3 * b / a) ^ 0.25;
    end
    far = 'The %s would be at V = %.4g, far outside the test points (%.4g to %.4g): not shown. Fly test points nearer that speed.';
    if vE >= lo && vE <= hi
        re.vE = vE;
        re.yE = xppCurveValue(f, vE);
    else
        re.noteE = sprintf(far, 'minimum', vE, f.xMin, f.xMax);
    end
    if vR >= lo && vR <= hi
        re.vR = vR;
        re.yR = xppCurveValue(f, vR);
    else
        re.noteR = sprintf(far, 'tangent point', vR, f.xMin, f.xMax);
    end
end
re.extrapE = re.vE < f.xMin || re.vE > f.xMax;
re.extrapR = re.vR < f.xMin || re.vR > f.xMax;
re.slope = re.yR / re.vR;
re.ratio = re.vR / re.vE;
end`,
  },
  {
    name: 'xppInteriorMin',
    deps: [],
    code: String.raw`function i = xppInteriorMin(values)
%XPPINTERIORMIN Index of the lowest interior local minimum of values (lower than the sample before it and not higher
%   than the one after it; never an end sample), or 0 when there is none.
i = 0;
k = find(values(2:end - 1) < values(1:end - 2) & values(2:end - 1) <= values(3:end)) + 1;
if ~isempty(k)
    [~, j] = min(values(k));
    i = k(j);
end
end`,
  },
  {
    name: 'xppBisect',
    deps: [],
    code: String.raw`function v = xppBisect(c, lo, hi, guess)
%XPPBISECT The root of the polynomial c (highest power first) in [lo, hi] where it goes from <= 0 to >= 0, by bisection
%   to full double precision, as the app does; guess when the bracket does not hold.
a = lo;
b = hi;
da = polyval(c, a);
db = polyval(c, b);
v = guess;
if da == 0
    v = a;
    return
end
if db == 0
    v = b;
    return
end
if ~(da < 0 && db > 0)
    return
end
for iteration = 1:200
    m = a + (b - a) / 2;
    if ~(m > a && m < b)
        break
    end
    dm = polyval(c, m);
    if dm == 0
        v = m;
        return
    end
    if dm < 0
        a = m;
    else
        b = m;
    end
end
v = a + (b - a) / 2;
end`,
  },
  {
    name: 'xppNiceRange',
    deps: [],
    code: String.raw`function r = xppNiceRange(values)
%XPPNICERANGE [lo hi] of the finite values widened to whole steps of 1, 2 or 5 x 10^n (about 6 steps across), as the
%   app rounds the axis ranges it sets itself.
values = values(isfinite(values));
r = [min(values) max(values)];
if isempty(values) || ~(r(2) > r(1))
    return
end
raw = (r(2) - r(1)) / 6;
scale = 10 ^ floor(log10(raw));
f = raw / scale;
if f < 1.5
    step = scale;
elseif f < 3
    step = 2 * scale;
elseif f < 7
    step = 5 * scale;
else
    step = 10 * scale;
end
r = [floor(r(1) / step) * step, ceil(r(2) / step) * step];
end`,
  },
  {
    name: 'xppAxesFromZero',
    deps: ['xppNiceRange'],
    code: String.raw`function xppAxesFromZero(ax)
%XPPAXESFROMZERO Both axes widened to take in zero, with round ends (the app's "Axes from zero").
xlim(ax, xppNiceRange([xlim(ax), 0]));
ylim(ax, xppNiceRange([ylim(ax), 0]));
end`,
  },
  {
    name: 'xppDrawRangeEndurance',
    deps: ['xppNiceRange', 'xppCurveValue', 'xppObstacles', 'xppPlaceLabel', 'xppReLabel'],
    code: String.raw`function xppDrawRangeEndurance(ax, reList, fromZero, colors, xUnit)
%XPPDRAWRANGEENDURANCE Draws each fit's range and endurance constructions as the app does: the minimum (max endurance)
%   with a dashed guide down to the x axis and one across the plot, the tangent from the origin (max range) running 40%
%   past the point it touches with a dashed guide down to the x axis, a marker at both points, the fitted curve carried
%   on (dashed) to a point outside the fitted speeds, and a label beside each marker where it covers the fewest data.
%   The axes take in the points (and zero with fromZero) with round ends. reList: cells of struct(fit, re, label, ...)
%   (xppFitCurve, xppRangeEndurance); colors: rows for max endurance and max range. When both rows are the same (ink:
%   the data use the construction colours), the V_R guide is dash-dot, so line styles tell the two apart.
names = {'Max endurance (minimum)', 'Max range (tangent from origin)'};
rangeGuide = '--';
if isequal(colors(1, :), colors(2, :))
    rangeGuide = '-.';
end
speeds = [];
values = [];
for k = 1:numel(reList)
    speeds = [speeds, reList{k}.re.vE, reList{k}.re.vR]; %#ok<AGROW>
    values = [values, reList{k}.re.yE, reList{k}.re.yR]; %#ok<AGROW>
end
found = isfinite(speeds);
if any(found) || fromZero
    zero = zeros(1, double(fromZero));
    xlim(ax, xppNiceRange([xlim(ax), speeds(found), zero]));
    ylim(ax, xppNiceRange([ylim(ax), values(found), zero]));
end
xl = xlim(ax);
yl = ylim(ax);
named = [false false];                                   % one legend entry per construction
guides = gobjects(0);
for k = 1:numel(reList)
    f = reList{k}.fit;
    re = reList{k}.re;
    known = [re.vE, re.vR];
    known = known(isfinite(known));
    if ~isempty(known) && min(known) < f.xMin
        v = linspace(min(known), f.xMin, 40);
        plot(ax, v, xppCurveValue(f, v), '--', 'Color', reList{k}.color, 'LineWidth', 1, 'HandleVisibility', 'off');
    end
    if ~isempty(known) && max(known) > f.xMax
        v = linspace(f.xMax, max(known), 40);
        plot(ax, v, xppCurveValue(f, v), '--', 'Color', reList{k}.color, 'LineWidth', 1, 'HandleVisibility', 'off');
    end
    if isfinite(re.vE)
        guides(end + 1) = plot(ax, [re.vE re.vE], [yl(1) re.yE], '--', 'Color', colors(1, :), 'LineWidth', 1); %#ok<AGROW>
        guides(end + 1) = plot(ax, xl, [re.yE re.yE], '--', 'Color', colors(1, :), 'LineWidth', 1); %#ok<AGROW>
        set(guides(end - 1:end), 'HandleVisibility', 'off');
        if ~named(1)
            set(guides(end - 1), 'HandleVisibility', 'on', 'DisplayName', names{1});
            named(1) = true;
        end
    end
    if isfinite(re.vR)
        stop = min(xl(2), 1.4 * re.vR);
        guides(end + 1) = plot(ax, [0 stop], [0 re.slope * stop], '-', 'Color', colors(2, :), 'LineWidth', 1); %#ok<AGROW>
        guides(end + 1) = plot(ax, [re.vR re.vR], [yl(1) re.yR], rangeGuide, 'Color', colors(2, :), 'LineWidth', 1); %#ok<AGROW>
        set(guides(end - 1:end), 'HandleVisibility', 'off');
        if ~named(2)
            set(guides(end - 1), 'HandleVisibility', 'on', 'DisplayName', names{2});
            named(2) = true;
        end
    end
end
uistack(guides, 'bottom');                               % under the data, as in the app
% Markers, then the labels, each placed away from everything drawn and from the labels before it.
for k = 1:numel(reList)
    re = reList{k}.re;
    if isfinite(re.vE)
        plot(ax, re.vE, re.yE, 'o', 'MarkerSize', 6, 'MarkerFaceColor', colors(1, :), 'MarkerEdgeColor', 'w', ...
            'HandleVisibility', 'off');
    end
    if isfinite(re.vR)
        plot(ax, re.vR, re.yR, 'o', 'MarkerSize', 6, 'MarkerFaceColor', colors(2, :), 'MarkerEdgeColor', 'w', ...
            'HandleVisibility', 'off');
    end
end
obstacles = xppObstacles(ax);
placed = zeros(0, 4);
% With several fits each label starts with its fit's name ("Heavy: max range V_R = 97 kt"), TeX characters escaped.
prefix = @(k) '';
leads = {'Max endurance V_E', 'Max range V_R'};
if numel(reList) > 1
    prefix = @(k) [regexprep(reList{k}.label, '([_^{}\\])', '\\$1') ': '];
    leads = {'max endurance V_E', 'max range V_R'};
end
for k = 1:numel(reList)
    re = reList{k}.re;
    if isfinite(re.vE)
        placed(end + 1, :) = xppPlaceLabel(ax, re.vE, re.yE, ...
            xppReLabel([prefix(k) leads{1}], re.vE, xUnit, re.extrapE), obstacles, placed); %#ok<AGROW>
    end
    if isfinite(re.vR)
        placed(end + 1, :) = xppPlaceLabel(ax, re.vR, re.yR, ...
            xppReLabel([prefix(k) leads{2}], re.vR, xUnit, re.extrapR), obstacles, placed); %#ok<AGROW>
    end
end
end`,
  },
  {
    name: 'xppReLabel',
    deps: [],
    code: String.raw`function s = xppReLabel(lead, v, unit, extrapolated)
%XPPRELABEL "Max endurance V_E = 72 kt" (TeX: V with subscript E), whole numbers from 20 up, else 3 significant
%   figures, as the app labels its constructions; "(extrapolated)" on a second line outside the fitted speeds.
if abs(v) >= 20
    s = sprintf('%s = %d', lead, round(v));
else
    s = sprintf('%s = %s', lead, num2str(v, 3));
end
if ~isempty(unit)
    s = [s ' ' regexprep(unit, '([_^{}\\])', '\\$1')];
end
if extrapolated
    s = {s, '(extrapolated)'};
end
end`,
  },
  {
    name: 'xppObstacles',
    deps: [],
    code: String.raw`function pts = xppObstacles(ax)
%XPPOBSTACLES Points along everything drawn in the axes, hidden legend entries included (at most 3000 per object;
%   two-point lines filled in), which the construction labels keep away from.
pts = zeros(0, 2);
for h = reshape(allchild(ax), 1, [])
    if ~isprop(h, 'XData') || ~isprop(h, 'YData')
        continue
    end
    x = double(h.XData(:));
    y = double(h.YData(:));
    if isempty(x) || numel(x) ~= numel(y)
        continue
    end
    if numel(x) == 2
        x = linspace(x(1), x(2), 60)';
        y = linspace(y(1), y(2), 60)';
    end
    keep = isfinite(x) & isfinite(y);
    x = x(keep);
    y = y(keep);
    every = max(1, ceil(numel(x) / 3000));
    pts = [pts; x(1:every:end), y(1:every:end)]; %#ok<AGROW>
end
end`,
  },
  {
    name: 'xppPlaceLabel',
    deps: [],
    code: String.raw`function box = xppPlaceLabel(ax, x, y, str, obstacles, placed)
%XPPPLACELABEL A label beside the point (x, y) at the first of the app's spots (left or right of it, one to three lines
%   up or down; upper left first) whose box covers the fewest obstacle points, stays inside the axes and overlaps no
%   earlier label (placed: rows of [left bottom width height]). Returns its box.
spots = [-1 1; -1 2; 1 -1; 1 1; -1 -1; 1 -2; -1 3; 1 2; -1 -2; 1 3; 1 -3; -1 -3];
xl = xlim(ax);
yl = ylim(ax);
gap = 0.012 * diff(xl);
t = text(ax, x, y, str, 'Interpreter', 'tex', 'FontSize', 9, 'BackgroundColor', 'w', 'Margin', 1, ...
    'VerticalAlignment', 'middle', 'Clipping', 'on');
step = 1.15 * t.Extent(4);
best = Inf;
choice = 1;
box = t.Extent;
for k = 1:size(spots, 1)
    align = 'right';
    if spots(k, 1) > 0
        align = 'left';
    end
    set(t, 'Position', [x + spots(k, 1) * gap, y + spots(k, 2) * step, 0], 'HorizontalAlignment', align);
    b = t.Extent;
    score = 0.01 * k;
    if b(1) < xl(1) || b(1) + b(3) > xl(2) || b(2) < yl(1) || b(2) + b(4) > yl(2)
        score = score + 500;
    end
    for j = 1:size(placed, 1)
        p = placed(j, :);
        if b(1) < p(1) + p(3) && p(1) < b(1) + b(3) && b(2) < p(2) + p(4) && p(2) < b(2) + b(4)
            score = score + 1000;
        end
    end
    score = score + sum(obstacles(:, 1) >= b(1) & obstacles(:, 1) <= b(1) + b(3) & ...
        obstacles(:, 2) >= b(2) & obstacles(:, 2) <= b(2) + b(4));
    if score < best
        best = score;
        choice = k;
        box = b;
    end
end
align = 'right';
if spots(choice, 1) > 0
    align = 'left';
end
set(t, 'Position', [x + spots(choice, 1) * gap, y + spots(choice, 2) * step, 0], 'HorizontalAlignment', align);
end`,
  },
  {
    name: 'xppReReport',
    deps: [],
    code: String.raw`function lines = xppReReport(reList, xUnit)
%XPPREREPORT The range and endurance results as text lines, every number at full precision (printed, and written to
%   out/range_endurance.txt). reList: cells of struct(fit, re, label, color, yUnit, target).
lines = {'Range and endurance from the X-Y fit (X-Plane Plotter MATLAB export)', ...
    'V_E: maximum endurance, the minimum of the fitted curve. V_R: maximum range, where the tangent from the origin touches it.', ...
    'For the weight and altitude flown: not reduced to standard conditions.'};
for k = 1:numel(reList)
    f = reList{k}.fit;
    re = reList{k}.re;
    yUnit = reList{k}.yUnit;
    switch f.model
        case 'power'
            model = 'power model y = A*V^3 + B/V';
        case 'drag'
            model = 'drag model y = A*V^2 + B/V^2';
        otherwise
            model = sprintf('polynomial of degree %d', f.degree);
    end
    lines{end + 1} = ''; %#ok<AGROW>
    lines{end + 1} = sprintf('%s: %s, through the %s', reList{k}.label, model, reList{k}.target); %#ok<AGROW>
    mark = {'', '   (extrapolated: outside the fitted speeds)'};
    lines{end + 1} = sprintf('V_E = %.15g %s%s', re.vE, xUnit, mark{1 + re.extrapE}); %#ok<AGROW>
    lines{end + 1} = sprintf('y_E = %.15g %s', re.yE, yUnit); %#ok<AGROW>
    lines{end + 1} = sprintf('V_R = %.15g %s%s', re.vR, xUnit, mark{1 + re.extrapR}); %#ok<AGROW>
    lines{end + 1} = sprintf('y_R = %.15g %s', re.yR, yUnit); %#ok<AGROW>
    lines{end + 1} = sprintf('y_R/V_R = %.15g   (slope of the tangent from the origin)', re.slope); %#ok<AGROW>
    lines{end + 1} = sprintf('V_R/V_E = %.15g', re.ratio); %#ok<AGROW>
    if strcmp(f.model, 'poly')
        for j = 1:numel(f.coeffs)
            lines{end + 1} = sprintf('c%d = %.15g', numel(f.coeffs) - j, f.coeffs(j)); %#ok<AGROW>
        end
    else
        lines{end} = sprintf('%s   (3^(1/4) = %.15g for this model)', lines{end}, 3 ^ 0.25);
        lines{end + 1} = sprintf('A = %.15g +/- %.15g', f.a, f.aSe); %#ok<AGROW>
        lines{end + 1} = sprintf('B = %.15g +/- %.15g', f.b, f.bSe); %#ok<AGROW>
    end
    lines{end + 1} = sprintf('R^2 = %.15g', f.r2); %#ok<AGROW>
    lines{end + 1} = sprintf('RMSE = %.15g %s', f.rmse, yUnit); %#ok<AGROW>
    lines{end + 1} = sprintf('n = %d', f.n); %#ok<AGROW>
    notes = unique({re.noteE, re.noteR}, 'stable');
    notes = notes(~cellfun('isempty', notes));
    for j = 1:numel(notes)
        lines{end + 1} = ['Note: ' notes{j}]; %#ok<AGROW>
    end
end
end`,
  },
  {
    name: 'xppFitOscillation',
    deps: ['xppOscillationSse', 'xppCrossings', 'xppLobePeaks', 'xppLogDecZeta'],
    code: String.raw`function f = xppFitOscillation(t, y, withSlope)
%XPPFITOSCILLATION Least-squares fit of y = A exp(-sigma tau) cos(wd tau + phi) + c + b tau, tau = t - t0.
%   t0 is the first sample time; b = 0 unless withSlope. fminsearch searches sigma and wd from several starts
%   (wd from the zero crossings of the detrended signal and from a scan of frequencies, sigma from the logarithmic
%   decrement of its peaks); A, phi, c and b are solved by linear least squares at every step.
t = t(:);
y = y(:);
f = struct('model', 'oscillation', 't0', NaN, 'A', NaN, 'sigma', NaN, 'wd', NaN, 'phi', NaN, 'c', NaN, ...
    'b', 0, 'period', NaN, 'wn', NaN, 'zeta', NaN, 'tHalf', NaN, 'r2', NaN, 'cycles', NaN, ...
    'zetaLogDec', NaN, 'fitted', [], 'message', '');
if numel(y) < 12
    f.message = sprintf('Need at least 12 samples to fit an oscillation (the window has %d).', numel(y));
    return
end
f.t0 = t(1);
tau = t - t(1);
span = tau(end);
steps = diff(tau);
dt = median(steps(steps > 0));
if ~(span > 0 && dt > 0)
    f.message = 'The window does not span any time.';
    return
end
state = warning;
restore = onCleanup(@() warning(state));               % puts the warning state back on return
warning('off', 'MATLAB:rankDeficientMatrix');
warning('off', 'MATLAB:singularMatrix');
warning('off', 'MATLAB:nearlySingularMatrix');

trend = ones(size(tau));
if withSlope
    trend = [trend, tau];
end
r = y - trend * (trend \ y);                             % the detrended signal
[crossing, between] = xppCrossings(tau, r);
starts = [];
if numel(crossing) >= 3
    starts(end + 1) = pi / median(diff(crossing));
end
trial = exp(linspace(log(0.5 * pi / span), log(pi / dt), 400));   % a quarter cycle per window to Nyquist
cost = zeros(size(trial));
for j = 1:numel(trial)
    cost(j) = xppOscillationSse([0, trial(j)], tau, y, withSlope);
end
[~, j] = min(cost);
starts(end + 1) = trial(j);
% Decay rate from successive half-cycle peaks: ln(a_j / a_j+1) = sigma * (Td / 2).
peak = xppLobePeaks(r, between);
sigma0 = 0;
if numel(peak) >= 2
    sigma0 = median(log(peak(1:end - 1) ./ peak(2:end))) / median(diff(crossing));
end
if ~isfinite(sigma0)
    sigma0 = 0;
end
options = optimset('Display', 'off', 'TolX', 1e-10, 'TolFun', 1e-12, 'MaxFunEvals', 4000, 'MaxIter', 4000);
best = [];
bestSse = Inf;
for w0 = starts
    for s0 = unique([sigma0, 0])
        q = fminsearch(@(q) xppOscillationSse(q, tau, y, withSlope), [s0, w0], options);
        q(2) = abs(q(2));
        sse = xppOscillationSse(q, tau, y, withSlope);
        if sse < bestSse
            best = q;
            bestSse = sse;
        end
    end
end
if isempty(best) || ~isfinite(bestSse)
    f.message = 'Could not find an oscillation in this window.';
    return
end
[sse, p, fitted] = xppOscillationSse(best, tau, y, withSlope);
f.sigma = best(1);
f.wd = best(2);
f.A = hypot(p(1), p(2));                                 % A cos(wd tau + phi) = A cos(phi) cos - A sin(phi) sin
f.phi = atan2(-p(2), p(1));
f.c = p(3);
if withSlope
    f.b = p(4);
end
f.wn = hypot(f.sigma, f.wd);
f.zeta = f.sigma / f.wn;
f.period = 2 * pi / f.wd;
f.tHalf = log(2) / f.sigma;                              % negative when it grows: |t_half| = time to double
f.r2 = 1 - sse / sum((y - mean(y)) .^ 2);
f.cycles = span * f.wd / (2 * pi);
f.fitted = fitted;
% Cross-check: log decrement of successive same-sign peaks about the fitted equilibrium, found as the app finds them
% (turning points at least 0.6 periods apart), so both report the same value.
e = y - f.c - f.b * tau;
f.zetaLogDec = xppLogDecZeta(tau, e, f.period, max(1, round(0.6 * f.period / dt)));
explained = 1 - sse / sum(r .^ 2);                       % share of the detrended variation
if f.cycles < 0.9
    f.message = sprintf('The window holds only %.2f cycles: select at least one full cycle (2-5 are better).', ...
        f.cycles);
elseif explained < 0.5
    f.message = sprintf('Poor fit: the oscillation explains only %.0f%% of the variation.', 100 * max(0, explained));
end
end`,
  },
  {
    name: 'xppCrossings',
    deps: [],
    code: String.raw`function [times, before] = xppCrossings(tau, r)
%XPPCROSSINGS Zero crossings of r that count: the signal must then pass 15% of its largest swing on the new
%   side, so noise near zero adds none. times are interpolated; before(k) is the sample before crossing k.
h = 0.15 * max(abs(r));
before = [];
state = 0;
last = 0;
for j = 1:numel(r)
    if j > 1 && ((r(j - 1) < 0 && r(j) >= 0) || (r(j - 1) > 0 && r(j) <= 0))
        last = j - 1;
    end
    if r(j) > h || r(j) < -h
        side = sign(r(j));
        if state ~= 0 && side ~= state && last > 0
            before(end + 1, 1) = last; %#ok<AGROW>
        end
        state = side;
    end
end
times = tau(before) + (tau(before + 1) - tau(before)) .* r(before) ./ (r(before) - r(before + 1));
end`,
  },
  {
    name: 'xppLobePeaks',
    deps: [],
    code: String.raw`function peak = xppLobePeaks(r, before)
%XPPLOBEPEAKS Largest |r| of each complete half cycle (between successive crossings).
peak = zeros(max(0, numel(before) - 1), 1);
for j = 1:numel(peak)
    peak(j) = max(abs(r(before(j) + 1:before(j + 1))));
end
end`,
  },
  {
    name: 'xppLogDecZeta',
    deps: ['xppPeaks'],
    code: String.raw`function zeta = xppLogDecZeta(tau, d, period, spacing)
%XPPLOGDECZETA Damping ratio from the logarithmic decrement, computed as the app computes it: the turning points of d
%   (xppPeaks, at least spacing samples apart), grouped in runs of successive same-sign peaks (maxima above zero,
%   minima below) 0.6 to 1.5 periods apart, peaks under 10% of the largest left out. Over all runs,
%   delta = sum(ln(x0 / xn)) / sum(n), and zeta = delta / sqrt(4 pi^2 + delta^2). NaN without a run of two peaks.
zeta = NaN;
if ~(period > 0)
    return
end
d = d(:);
tau = tau(:);
[pos, isMax] = xppPeaks(d, spacing);
if isempty(pos)
    return
end
floorLevel = 0.1 * max(abs(d(pos)));
sumLog = 0;
cycles = 0;
for kind = [true, false]
    sel = pos(isMax == kind);
    run = [];
    for k = 1:numel(sel) + 1                             % one step past the end closes the last run
        keep = false;
        if k <= numel(sel)
            v = d(sel(k));
            keep = abs(v) >= floorLevel && ((kind && v > 0) || (~kind && v < 0));
        end
        if ~isempty(run) && (~keep || tau(sel(k)) - tau(run(end)) < 0.6 * period ...
                || tau(sel(k)) - tau(run(end)) > 1.5 * period)
            if numel(run) >= 2
                sumLog = sumLog + log(abs(d(run(1))) / abs(d(run(end))));
                cycles = cycles + numel(run) - 1;
            end
            run = [];
        end
        if keep
            run(end + 1) = sel(k); %#ok<AGROW>
        end
    end
end
if cycles > 0
    delta = sumLog / cycles;
    zeta = delta / sqrt(4 * pi ^ 2 + delta ^ 2);
end
end`,
  },
  {
    name: 'xppPeaks',
    deps: ['xppTurningPoints', 'xppBaseMinima'],
    code: String.raw`function [pos, isMax] = xppPeaks(values, spacing)
%XPPPEAKS Turning points as the app finds them: strict local maxima and minima (a plateau counts once, at its middle
%   sample; never the end samples) with a prominence of at least 5% of the signal's range, thinned so that no two of
%   a kind are closer than spacing samples (the more prominent stays). pos ascending; isMax true for maxima.
values = values(:);
pos = zeros(0, 1);
isMax = false(0, 1);
if numel(values) < 3 || ~(max(values) > min(values))
    return
end
threshold = 0.05 * (max(values) - min(values));
spacing = max(1, floor(spacing));
for kind = [true, false]
    w = values;
    if ~kind
        w = -values;
    end
    c = xppTurningPoints(w);
    prom = w(c) - max(xppBaseMinima(c, w, false), xppBaseMinima(c, w, true));
    ok = prom >= threshold & prom > 0;
    c = c(ok);
    prom = prom(ok);
    keep = true(size(c));
    if spacing > 1
        [~, order] = sort(-prom);                        % most prominent first (a stable sort: ties in time order)
        for j = order(:)'
            if keep(j)
                near = abs(c - c(j)) < spacing;
                near(j) = false;
                keep(near) = false;
            end
        end
    end
    pos = [pos; c(keep)]; %#ok<AGROW>
    isMax = [isMax; repmat(kind, nnz(keep), 1)]; %#ok<AGROW>
end
[pos, order] = sort(pos);
isMax = isMax(order);
end`,
  },
  {
    name: 'xppTurningPoints',
    deps: [],
    code: String.raw`function c = xppTurningPoints(w)
%XPPTURNINGPOINTS Strict local maxima of w: a plateau counts once, at its middle sample; never the end samples.
m = numel(w);
c = zeros(0, 1);
i = 2;
while i < m
    if w(i) > w(i - 1)
        j = i;
        while j < m && w(j + 1) == w(i)
            j = j + 1;
        end
        if j < m && w(j + 1) < w(i)
            c(end + 1, 1) = floor((i + j) / 2); %#ok<AGROW>
        end
        i = j + 1;
    else
        i = i + 1;
    end
end
end`,
  },
  {
    name: 'xppBaseMinima',
    deps: [],
    code: String.raw`function base = xppBaseMinima(c, w, reverse)
%XPPBASEMINIMA For each sample index in c: the minimum of w between it and the nearest strictly higher sample before
%   it (after it when reverse), or the signal's edge: the base of a peak there, on that side. One pass with a stack.
m = numel(w);
out = zeros(m, 1);
stackIndex = zeros(m, 1);
stackMin = zeros(m, 1);
top = 0;
for s = 1:m
    i = s;
    if reverse
        i = m + 1 - s;
    end
    current = w(i);
    while top > 0 && w(stackIndex(top)) <= w(i)
        current = min(current, stackMin(top));
        top = top - 1;
    end
    out(i) = current;
    top = top + 1;
    stackIndex(top) = i;
    stackMin(top) = current;
end
base = out(c);
end`,
  },
  {
    name: 'xppOscillationSse',
    deps: [],
    code: String.raw`function [sse, p, fitted] = xppOscillationSse(q, tau, y, withSlope)
%XPPOSCILLATIONSSE Residual sum of squares of the oscillation for q = [sigma, wd], the linear parameters
%   p = [A cos(phi), -A sin(phi), c, b] solved by least squares.
e = exp(-q(1) * tau);
M = [e .* cos(q(2) * tau), e .* sin(q(2) * tau), ones(size(tau))];
if withSlope
    M = [M, tau];
end
p = M \ y;
fitted = M * p;
sse = sum((y - fitted) .^ 2);
if ~isfinite(sse)
    sse = Inf;
end
end`,
  },
  {
    name: 'xppFitFirstOrder',
    deps: ['xppFirstOrderSse'],
    code: String.raw`function f = xppFitFirstOrder(t, y)
%XPPFITFIRSTORDER Least-squares fit of y = c + A exp(-k tau), tau = t - t0: time constant T = 1/k (k < 0: the
%   response grows). fminsearch searches k from several starts (the 63% point, a scan of rates); c and A are
%   solved by linear least squares at every step.
t = t(:);
y = y(:);
f = struct('model', 'first-order', 't0', NaN, 'A', NaN, 'c', NaN, 'k', NaN, 'T', NaN, 'tHalf', NaN, ...
    'r2', NaN, 'fitted', [], 'message', '');
if numel(y) < 6
    f.message = sprintf('Need at least 6 samples to fit a first-order response (the window has %d).', numel(y));
    return
end
f.t0 = t(1);
tau = t - t(1);
span = tau(end);
steps = diff(tau);
dt = median(steps(steps > 0));
if ~(span > 0 && dt > 0)
    f.message = 'The window does not span any time.';
    return
end
state = warning;
restore = onCleanup(@() warning(state));               % puts the warning state back on return
warning('off', 'MATLAB:rankDeficientMatrix');
warning('off', 'MATLAB:singularMatrix');
warning('off', 'MATLAB:nearlySingularMatrix');

starts = [];
yEnd = mean(y(max(1, end - ceil(numel(y) / 10) + 1):end));
gap = abs(y - yEnd);
j63 = find(gap <= exp(-1) * gap(1), 1);                  % 63% of the way to the final value
if ~isempty(j63) && tau(j63) > 0
    starts(end + 1) = 1 / tau(j63);
end
rates = exp(linspace(log(0.05 / span), log(2 / dt), 60));
rates = [rates, -rates(rates < 40 / span)];
cost = zeros(size(rates));
for j = 1:numel(rates)
    cost(j) = xppFirstOrderSse(rates(j), tau, y);
end
[~, j] = min(cost);
starts(end + 1) = rates(j);
options = optimset('Display', 'off', 'TolX', 1e-12, 'TolFun', 1e-12, 'MaxFunEvals', 2000, 'MaxIter', 2000);
best = NaN;
bestSse = Inf;
for k0 = starts
    k = fminsearch(@(k) xppFirstOrderSse(k, tau, y), k0, options);
    sse = xppFirstOrderSse(k, tau, y);
    if sse < bestSse
        best = k;
        bestSse = sse;
    end
end
if ~isfinite(bestSse)
    f.message = 'Could not fit a first-order response to this window.';
    return
end
[sse, p, fitted] = xppFirstOrderSse(best, tau, y);
f.k = best;
f.c = p(1);
f.A = p(2);
f.T = 1 / best;
f.tHalf = log(2) * f.T;
f.r2 = 1 - sse / sum((y - mean(y)) .^ 2);
f.fitted = fitted;
if abs(best) * span < 0.1
    f.message = 'The response is nearly linear in this window: select a longer window.';
elseif f.r2 < 0.5
    f.message = sprintf('Poor fit (R^2 = %.2f): the window may not contain a first-order response.', f.r2);
end
end`,
  },
  {
    name: 'xppFirstOrderSse',
    deps: [],
    code: String.raw`function [sse, p, fitted] = xppFirstOrderSse(k, tau, y)
%XPPFIRSTORDERSSE Residual sum of squares of y = c + A exp(-k tau), with p = [c, A] solved by least squares.
M = [ones(size(tau)), exp(-k * tau)];
p = M \ y;
fitted = M * p;
sse = sum((y - fitted) .^ 2);
if ~isfinite(sse)
    sse = Inf;
end
end`,
  },
  {
    name: 'xppModeReport',
    deps: [],
    code: String.raw`function report = xppModeReport(f, name, rows, t)
%XPPMODEREPORT The mode-fit results as lines of text (printed, and written to out/mode_fit.txt).
report = {sprintf('Mode fit (%s): %s', f.model, name)};
if isempty(t)
    report{2} = 'No samples with values in the window.';
    return
end
window = sprintf('Window: rows %d-%d (MATLAB, 1-based), elapsed %.3f-%.3f s, %d samples', rows(1), rows(end), ...
    t(1), t(end), numel(t));
if strcmp(f.model, 'oscillation')
    grows = '';
    if f.sigma < 0
        grows = ' (negative: the oscillation grows; |t_half| is the time to double)';
    end
    report{2} = sprintf('Td = %.4g s, zeta = %.4g, wn = %.4g rad/s, R^2 = %.4f', f.period, f.zeta, f.wn, f.r2);
    body = {
        'Model: y = A exp(-sigma tau) cos(wd tau + phi) + c + b tau, tau = t - t0'
        sprintf('period Td = %.6g s', f.period)
        sprintf('wd        = %.6g rad/s', f.wd)
        sprintf('wn        = %.6g rad/s', f.wn)
        sprintf('zeta      = %.6g', f.zeta)
        sprintf('t_half    = %.6g s%s', f.tHalf, grows)
        sprintf('R^2       = %.6g', f.r2)
        sprintf('sigma = %.6g 1/s, A = %.6g, phi = %.6g rad, c = %.6g, b = %.6g per s, t0 = %.6g s', ...
            f.sigma, f.A, f.phi, f.c, f.b, f.t0)
        sprintf('cycles in the window = %.3g; zeta from the log decrement = %.4g', f.cycles, f.zetaLogDec)
        };
else
    grows = '';
    if f.k < 0
        grows = ' (negative: the response grows)';
    end
    report{2} = sprintf('T = %.4g s, t_half = %.4g s, R^2 = %.4f', f.T, f.tHalf, f.r2);
    body = {
        'Model: y = c + A exp(-tau / T), tau = t - t0'
        sprintf('time constant T = %.6g s%s', f.T, grows)
        sprintf('t_half = ln(2) T = %.6g s', f.tHalf)
        sprintf('R^2 = %.6g', f.r2)
        sprintf('A = %.6g, c = %.6g, t0 = %.6g s', f.A, f.c, f.t0)
        };
end
report = [report, {window}, body'];
if ~isempty(f.message)
    report{end + 1} = ['Note: ' f.message];
end
end`,
  },
  // ---- formula helpers (see matlabFormula.ts)
  {
    name: 'xppReal',
    deps: [],
    code: String.raw`function r = xppReal(z)
%XPPREAL Real results only, as JavaScript's Math gives them: complex values (sqrt(-1), log(-1)...) become NaN.
r = real(z);
r(imag(z) ~= 0) = NaN;
end`,
  },
  {
    name: 'xppCmp',
    deps: [],
    code: String.raw`function r = xppCmp(a, b, op)
%XPPCMP Comparison as the app's formulas make it: 1 or 0, and NaN where either side is NaN.
switch op
    case '<'
        r = double(a < b);
    case '<='
        r = double(a <= b);
    case '>'
        r = double(a > b);
    case '>='
        r = double(a >= b);
    case '=='
        r = double(a == b);
    otherwise
        r = double(a ~= b);
end
r(isnan(a) | isnan(b)) = NaN;
end`,
  },
  {
    name: 'xppIf',
    deps: [],
    code: String.raw`function r = xppIf(c, a, b)
%XPPIF The app's formula c ? a : b, row by row: a where c is non-zero, b where it is zero, NaN where c is NaN.
%   Each argument is a scalar or a column with one value per row.
n = max([numel(c), numel(a), numel(b)]);
r = b + zeros(n, 1);
a = a + zeros(n, 1);
c = c + zeros(n, 1);
r(c ~= 0) = a(c ~= 0);
r(isnan(c)) = NaN;
end`,
  },
  {
    name: 'xppSegmentId',
    deps: [],
    code: String.raw`function id = xppSegmentId(segStart, n)
%XPPSEGMENTID The segment number (1, 2, ...) of each of n rows from the segments' first rows (segStart).
id = zeros(n, 1);
id(segStart(segStart >= 1 & segStart <= n)) = 1;
id = max(1, cumsum(id));
end`,
  },
  {
    name: 'xppDdt',
    deps: ['xppSegmentId'],
    code: String.raw`function d = xppDdt(x, t, segStart)
%XPPDDT The app's diff(x): d/dt by central differences, one-sided at the ends, next to missing samples and at
%   segment edges (a neighbour across a sim reset or recording gap counts as missing); NaN where x is missing or
%   time does not advance.
x = x + zeros(size(t));
n = numel(x);
ok = isfinite(x) & isfinite(t);
id = xppSegmentId(segStart, n);
same = id(1:end - 1) == id(2:end);                       % rows k and k + 1 are in one segment
prev = [false; ok(1:end - 1) & same];
next = [ok(2:end) & same; false];
xp = [NaN; x(1:end - 1)];
xn = [x(2:end); NaN];
tp = [NaN; t(1:end - 1)];
tn = [t(2:end); NaN];
dx = NaN(n, 1);
dt = NaN(n, 1);
both = ok & prev & next;
dx(both) = xn(both) - xp(both);
dt(both) = tn(both) - tp(both);
ahead = ok & next & ~prev;
dx(ahead) = xn(ahead) - x(ahead);
dt(ahead) = tn(ahead) - t(ahead);
behind = ok & prev & ~next;
dx(behind) = x(behind) - xp(behind);
dt(behind) = t(behind) - tp(behind);
d = NaN(n, 1);
d(dt > 0) = dx(dt > 0) ./ dt(dt > 0);
end`,
  },
  {
    name: 'xppInteg',
    deps: ['xppSegmentId'],
    code: String.raw`function s = xppInteg(x, t, segStart)
%XPPINTEG The app's integ(x): running trapezoid integral over time from the first finite sample (0 there);
%   rows without a value stay NaN, missing samples are bridged linearly and nothing is added across a sim reset
%   or recording gap (compensated sum, as in the app).
x = x + zeros(size(t));
s = NaN(numel(x), 1);
id = xppSegmentId(segStart, numel(x));
total = 0;
compensation = 0;
last = 0;
for i = 1:numel(x)
    if ~isfinite(x(i)) || ~isfinite(t(i))
        continue
    end
    if last > 0 && id(last) == id(i) && t(i) - t(last) > 0
        increment = 0.5 * (x(i) + x(last)) * (t(i) - t(last));
        updated = total + increment;
        if abs(total) >= abs(increment)
            compensation = compensation + (total - updated + increment);
        else
            compensation = compensation + (increment - updated + total);
        end
        total = updated;
    end
    s(i) = total + compensation;
    last = i;
end
end`,
  },
  {
    name: 'xppSmooth',
    deps: ['xppSegmentId'],
    code: String.raw`function s = xppSmooth(x, t, seconds, segStart)
%XPPSMOOTH The app's smooth(x, seconds): centred moving average over |t_j - t_i| <= seconds/2 within row i's
%   segment (never across a sim reset or recording gap); rows without a value stay NaN and missing samples inside
%   the window are ignored.
x = x + zeros(size(t));
n = numel(x);
s = NaN(n, 1);
id = xppSegmentId(segStart, n);
half = seconds / 2;
reference = x(find(isfinite(x), 1));
if isempty(reference)
    return
end
lo = 1;
hi = 1;
total = 0;
count = 0;
for i = 1:n
    if ~isfinite(t(i))
        continue
    end
    while hi <= n && id(hi) == id(i) && (~isfinite(t(hi)) || t(hi) <= t(i) + half)
        if isfinite(x(hi)) && isfinite(t(hi))
            total = total + (x(hi) - reference);
            count = count + 1;
        end
        hi = hi + 1;
    end
    while lo < hi && (id(lo) ~= id(i) || ~isfinite(t(lo)) || t(lo) < t(i) - half)
        if isfinite(x(lo)) && isfinite(t(lo))
            total = total - (x(lo) - reference);
            count = count - 1;
        end
        lo = lo + 1;
    end
    if isfinite(x(i)) && count > 0
        s(i) = reference + total / count;
    end
end
end`,
  },
  {
    name: 'xppLag',
    deps: ['xppSegmentId'],
    code: String.raw`function y = xppLag(x, rows, n, segStart)
%XPPLAG The app's lag(x, rows): y(i) = x(i - rows), NaN where that row is outside the log or across a sim reset
%   or recording gap (another segment).
x = x + zeros(n, 1);
k = round(rows);
y = NaN(n, 1);
id = xppSegmentId(segStart, n);
i = max(1, k + 1):min(n, n + k);
i = i(id(i) == id(i - k));
y(i) = x(i - k);
end`,
  },
]

const BY_NAME = new Map(LIBRARY.map((f) => [f.name, f]))

/** Names of every function in the library, in output order. */
export const MATLAB_LIBRARY_FUNCTIONS: readonly string[] = LIBRARY.map((f) => f.name)

/**
 * The local functions for `requested` (and everything they call), in library order, as script lines: each function
 * preceded by a blank line. Throws for an unknown name (a programming error in the generator).
 */
export function matlabLibrary(requested: Iterable<string>): string[] {
  const needed = new Set<string>()
  const visit = (name: string): void => {
    if (needed.has(name)) return
    const fn = BY_NAME.get(name)
    if (!fn) throw new Error(`matlabLibrary: unknown function ${name}`)
    needed.add(name)
    for (const dep of fn.deps) visit(dep)
  }
  for (const name of requested) visit(name)
  return LIBRARY.filter((fn) => needed.has(fn.name)).flatMap((fn) => ['', ...fn.code.split('\n')])
}
