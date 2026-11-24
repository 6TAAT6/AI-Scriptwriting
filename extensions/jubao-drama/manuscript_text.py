"""HTML剧本的可见正文与原始位置映射，共用于显示统计和要求核验。"""

from html import unescape
from html.parser import HTMLParser
import re


class _VisibleManuscript(HTMLParser):
    """排版标签只影响可见分行；字符到原始稿件的位置映射供局部改稿保留原字节。"""
    _BLOCKS = {'address','article','aside','blockquote','div','footer','h1','h2','h3','h4','h5','h6',
               'header','li','main','nav','ol','p','section','table','tr','ul'}
    _HIDDEN = {'script','style','template'}

    def __init__(self, content):
        super().__init__(convert_charrefs=False)
        self.content = content
        self.lines = [0, *(match.end() for match in re.finditer('\n', content))]
        self.text = []
        self.offsets = []
        self.line_start = 0
        self.hidden = []
        self.feed(content)
        self.close()

    def _position(self):
        line, column = self.getpos()
        return self.lines[line - 1] + column

    def _append(self, text, start, end):
        for index, char in enumerate(text):
            self.offsets.append(self.line_start if not self.text or self.text[-1] == '\n' else min(start + index, end))
            self.text.append(char)
            if char == '\n':
                self.line_start = min(start + index + 1, end)

    def _break(self, start, end):
        if self.text and self.text[-1] != '\n':
            self._append('\n', start, end)
        self.line_start = end

    def handle_starttag(self, tag, attrs):
        start = self._position()
        end = start + len(self.get_starttag_text())
        if tag in self._HIDDEN:
            self.hidden.append(tag)
        if self.hidden:
            return
        if tag in self._BLOCKS:
            self._break(start, start)
        elif tag == 'br':
            self._break(start, end)

    def handle_endtag(self, tag):
        start = self._position()
        end = self.content.find('>', start) + 1
        if self.hidden:
            if tag == self.hidden[-1]:
                self.hidden.pop()
                if not self.hidden:
                    self.line_start = end
            return
        if tag in self._BLOCKS:
            self._break(start, end)

    def handle_data(self, data):
        if not self.hidden:
            start = self._position()
            self._append(data, start, start + len(data))

    def handle_entityref(self, name):
        if not self.hidden:
            start = self._position()
            self._append(unescape('&' + name + ';'), start, start + len(name) + 2)

    def handle_charref(self, name):
        if not self.hidden:
            start = self._position()
            self._append(unescape('&#' + name + ';'), start, start + len(name) + 3)


def visible_manuscript(content):
    if not re.search(r'</?[A-Za-z][^>]*>', content):
        return content, list(range(len(content)))
    parsed = _VisibleManuscript(content)
    return ''.join(parsed.text), parsed.offsets


