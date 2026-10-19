#!/usr/bin/env python3
"""Помощна програма на RGB Changer за Logitech G515 (Linux).

Паметта на клавиатурата пази само ефекта и основния цвят („Запиши в клавиатурата“ на сайта).
Тази програма показва и цветовете по клавиши без отворен браузър: щом клавиатурата се включи,
събуди или свърже отново, тя поема подсветката (HID++ 0x8071/0x8081) и рисува кадъра от
~/.config/rgb-changer/g515.json („Файл за помощната програма“ на сайта; програмата следи файла).

Докато подсветката е у програмата, фърмуерът не я затъмнява сам, затова програмата прави това
като него: затъмнява след неактивност и изключва подсветката след времето за заспиване
(таймерите се четат от клавиатурата, 0x8071 fn7). При спиране (Ctrl+C или
systemctl --user stop rgb-changer-g515) връща подсветката от паметта на клавиатурата.

Само стандартната библиотека на Python 3. Нужен е достъп до /dev/hidraw* – правилото
42-logitech-webhid.rules в тази папка (същото, което сайтът показва за WebHID).
Протоколът следва бележките на logirgb (github.com/mevdschee/logirgb/tree/main/research), Solaar и OpenRGB.
"""

import argparse
import glob
import json
import os
import select
import signal
import time

LONG_REPORT = 0x11
SHORT_REPORT = 0x10
LONG_LENGTH = 20
SOFTWARE_ID = 0x0B  # сайтът използва 0x0A, така че отговорите не се смесват
DIRECT_DEVICE = 0xFF

ROOT = 0x0000
DEVICE_NAME = 0x0005
RGB_EFFECTS = 0x8071
PER_KEY_LIGHTING = 0x8081
PROFILE_MANAGEMENT = 0x8101

EFFECT_STATIC = 0x0001
DIM_PERCENT = 30
NEVER = 0xFFFF

POLL_S = 5.0         # проверка дали клавиатурата не се е върнала към паметта си (рестарт, дълбок сън)
RESCAN_S = 5.0       # търсене на нови /dev/hidraw* и събудени клавиатури зад приемника
CONFIG_CHECK_S = 2.0
CLAIM_SETTLE_S = 1.5  # след поемане фърмуерът праща фалшива двойка „неактивна/активна“
DEFAULT_CONFIG = os.path.expanduser('~/.config/rgb-changer/g515.json')


def log(message):
    print(time.strftime('%H:%M:%S'), message, flush=True)


class HidppError(Exception):
    def __init__(self, code):
        super().__init__(f'HID++ грешка 0x{code:02x}')
        self.code = code


# --- КОНФИГУРАЦИЯ ---
class Config:
    """Цветовете от сайта: основен цвят и зона 0x8081 → цвят за клавишите с различен цвят."""

    def __init__(self, data):
        self.base = parse_color(data.get('base', 'ffffff'))
        self.keys = {int(zone): parse_color(color) for zone, color in data.get('keys', {}).items()
                     if 1 <= int(zone) <= 255}
        # Без цветове по клавиши паметта на клавиатурата стига – програмата не прави нищо
        self.active = data.get('effect', 'static') == 'static' and bool(self.keys)


def parse_color(text):
    text = str(text).lstrip('#')
    if len(text) != 6:
        raise ValueError(f'невалиден цвят {text!r}')
    return tuple(int(text[i:i + 2], 16) for i in (0, 2, 4))


def scale(color, percent):
    return tuple(round(value * percent / 100) for value in color)


def load_config(path):
    with open(path, encoding='utf-8') as file:
        return Config(json.load(file))


# --- HID++ ПРЕЗ /dev/hidraw ---
class Node:
    """Един /dev/hidraw* възел. Отговорите се разпознават по устройство, feature и функция; всичко друго са събития."""

    def __init__(self, path, fd):
        self.path = path
        self.fd = fd
        self.events = []
        self.next_probe = 0.0

    def close(self):
        try:
            os.close(self.fd)
        except OSError:
            pass

    def read_report(self, timeout):
        ready, _, _ = select.select([self.fd], [], [], max(timeout, 0))
        return self.read() if ready else None

    def read(self):
        report = os.read(self.fd, 64)
        if not report:
            raise OSError('устройството е изключено')
        return report

    def request(self, index, feature_index, fn, params=(), timeout=1.0):
        function_id = (fn & 0xF0) | SOFTWARE_ID
        data = bytes([LONG_REPORT, index, feature_index, function_id, *params])[:LONG_LENGTH]
        os.write(self.fd, data.ljust(LONG_LENGTH, b'\0'))
        deadline = time.monotonic() + timeout
        while True:
            report = self.read_report(deadline - time.monotonic())
            if report is None:
                raise TimeoutError('устройството не отговори')
            if len(report) >= 6 and report[0] in (LONG_REPORT, SHORT_REPORT) and report[1] == index:
                if report[2] == feature_index and report[3] == function_id:
                    return report[4:]
                if report[2] in (0xFF, 0x8F) and report[3] == feature_index and report[4] == function_id:
                    raise HidppError(report[5])
            self.events.append(report)


def candidates():
    """Logitech hidraw възли, които обявяват дългия HID++ отчет (0x11)."""
    for sys_dir in sorted(glob.glob('/sys/class/hidraw/hidraw*')):
        try:
            with open(os.path.join(sys_dir, 'device', 'uevent'), encoding='utf-8') as file:
                hid_id = next((line.split('=', 1)[1].strip() for line in file if line.startswith('HID_ID=')), '')
            with open(os.path.join(sys_dir, 'device', 'report_descriptor'), 'rb') as file:
                descriptor = file.read()
        except OSError:
            continue
        parts = hid_id.split(':')
        if len(parts) == 3 and int(parts[1], 16) == 0x046D and b'\x85\x11' in descriptor:
            yield '/dev/' + os.path.basename(sys_dir)


def open_node(path):
    return os.open(path, os.O_RDWR)


# --- КЛАВИАТУРА ---
class Keyboard:
    def __init__(self, node, index):
        self.node = node
        self.index = index
        self.features = {ROOT: 0}
        self.name = 'Logitech'
        self.static_index = None
        self.claimed = False
        self.state = 'active'  # active | dim | off
        self.idle_s = 60
        self.sleep_s = 300
        self.off_at = None
        self.settle_until = 0.0
        self.next_poll = 0.0
        self.reachable = True

    def feature(self, feature_id):
        if feature_id not in self.features:
            reply = self.node.request(self.index, 0, 0x00, [feature_id >> 8, feature_id & 0xFF])
            self.features[feature_id] = reply[0] or None
        return self.features[feature_id]

    def call(self, feature_id, fn, params=()):
        feature_index = self.feature(feature_id)
        if not feature_index:
            raise RuntimeError(f'няма функция 0x{feature_id:04x}')
        # „Заето“ (0x08) идва, докато клавиатурата обработва предишен кадър
        for attempt in range(1, 5):
            try:
                return self.node.request(self.index, feature_index, fn, params)
            except HidppError as error:
                if error.code != 0x08 or attempt == 4:
                    raise
                time.sleep(0.04 * attempt)

    def read_name(self):
        length = self.call(DEVICE_NAME, 0x00)[0]
        name = b''
        while len(name) < length:
            name += bytes(self.call(DEVICE_NAME, 0x10, [len(name)]))
        return name[:length].decode('utf-8', 'replace').rstrip('\0')

    def find_static_effect(self):
        count = self.call(RGB_EFFECTS, 0x00, [0x00, 0xFF, 0x00])[4]
        for index in range(count):
            info = self.call(RGB_EFFECTS, 0x00, [0x00, index, 0x00])
            if (info[2] << 8 | info[3]) == EFFECT_STATIC:
                return index
        raise RuntimeError('клавиатурата няма статичен ефект')

    def read_timers(self):
        reply = self.call(RGB_EFFECTS, 0x70, [0x00])
        self.idle_s = reply[3] << 8 | reply[4]
        self.sleep_s = reply[5] << 8 | reply[6]

    # Статичен ефект в основния цвят, всички зони в основния цвят (иначе незаписаните светват в бяло),
    # после клавишите с различен цвят на групи по 13 и накрая frameEnd, който показва кадъра
    def paint(self, config, percent=100):
        r, g, b = scale(config.base, percent)
        self.call(RGB_EFFECTS, 0x10, [0x00, self.static_index, r, g, b, 0x02, 0, 0, 0, 0, 0, 0, 0x01])
        self.call(PER_KEY_LIGHTING, 0x50, [1, 111, r, g, b])
        groups = {}
        for zone, color in sorted(config.keys.items()):
            groups.setdefault(scale(color, percent), []).append(zone)
        for color, zones in groups.items():
            for start in range(0, len(zones), 13):
                self.call(PER_KEY_LIGHTING, 0x60, [*color, *zones[start:start + 13]])
        self.call(PER_KEY_LIGHTING, 0x70, [0, 0, 0, 0, 0])

    def claim(self, config):
        if self.feature(PROFILE_MANAGEMENT):
            self.call(PROFILE_MANAGEMENT, 0x60, [0x05])
        # Програмата държи клъстерите и захранването (03) и иска събитие при неактивност (04)
        self.call(RGB_EFFECTS, 0x50, [0x01, 0x03, 0x04])
        self.claimed = True
        self.state = 'active'
        self.off_at = None
        self.settle_until = time.monotonic() + CLAIM_SETTLE_S
        self.read_timers()
        # Първият кадър след поемане понякога изпреварва фърмуера (Solaar), затова се праща два пъти
        self.paint(config)
        time.sleep(0.1)
        self.paint(config)
        log(f'{self.name}: цветовете по клавиши са показани '
            f'(затъмняване след {fmt_timer(self.idle_s)}, изключване след {fmt_timer(self.sleep_s)}).')

    def release(self):
        self.claimed = False
        if self.state == 'off':
            self.call(RGB_EFFECTS, 0x80, [0x01, 0x01])
        self.call(RGB_EFFECTS, 0x50, [0x01, 0x00, 0x00])
        if self.feature(PROFILE_MANAGEMENT):
            self.call(PROFILE_MANAGEMENT, 0x60, [0x03])
        self.state = 'active'

    def poll(self, config):
        if self.claimed and self.feature(PROFILE_MANAGEMENT):
            mode = self.call(PROFILE_MANAGEMENT, 0x60, [0x00])
            if mode[0] & 1:
                log(f'{self.name}: клавиатурата се върна към подсветката от паметта си – поемам я отново.')
                self.claimed = False
        if not self.claimed:
            self.claim(config)

    def go_idle(self, config):
        self.paint(config, DIM_PERCENT)
        self.call(RGB_EFFECTS, 0x50, [0x01, 0x03, 0x02])  # събитие при следващо натискане
        self.state = 'dim'
        self.off_at = (time.monotonic() + self.sleep_s - self.idle_s
                       if self.sleep_s != NEVER and self.sleep_s > self.idle_s else None)

    def go_off(self):
        self.call(RGB_EFFECTS, 0x80, [0x01, 0x03])
        self.state = 'off'
        self.off_at = None

    def wake(self, config):
        if self.state == 'off':
            # Първата команда след събуждане понякога не минава (Solaar)
            for attempt in range(3):
                try:
                    self.call(RGB_EFFECTS, 0x80, [0x01, 0x01])
                    break
                except (HidppError, TimeoutError):
                    if attempt == 2:
                        raise
                    time.sleep(0.1)
        self.call(RGB_EFFECTS, 0x50, [0x01, 0x03, 0x04])
        self.settle_until = time.monotonic() + CLAIM_SETTLE_S
        self.state = 'active'
        self.off_at = None
        self.paint(config)

    def on_report(self, report, config):
        if len(report) < 5 or report[1] != self.index:
            return
        # Приемникът съобщава за връзка с клавиатурата (HID++ 1.0, 0x41) – проверка веднага
        if report[2] == 0x41:
            if not report[4] & 0x40:
                self.next_poll = time.monotonic() + 1.0
            return
        rgb_index = self.features.get(RGB_EFFECTS)
        if not (self.claimed and rgb_index and report[0] == LONG_REPORT
                and report[2] == rgb_index and report[3] == 0x10):
            return
        if time.monotonic() < self.settle_until:
            return
        active = report[4] != 0
        if not active and self.state == 'active':
            self.go_idle(config)
        elif active and self.state != 'active':
            self.wake(config)


def fmt_timer(seconds):
    return 'никога' if seconds in (0, NEVER) else f'{seconds} s'


# --- ОСНОВЕН ЦИКЪЛ ---
class Helper:
    def __init__(self, config_path):
        self.config_path = config_path
        self.config = None
        self.config_mtime = None
        self.nodes = {}       # път → Node
        self.keyboards = []
        self.stopping = False
        self.denied = set()
        self.next_scan = 0.0
        self.next_config = 0.0

    def reload_config(self):
        try:
            mtime = os.stat(self.config_path).st_mtime
        except OSError:
            if self.config_mtime != 'missing':
                log(f'Няма файл {self.config_path} – изтегли го от сайта („Файл за помощната програма“).')
                self.config_mtime = 'missing'
                self.config = None
                self.release_all()
            return
        if mtime == self.config_mtime:
            return
        self.config_mtime = mtime
        try:
            self.config = load_config(self.config_path)
        except (OSError, ValueError) as error:
            log(f'Файлът {self.config_path} не може да се прочете: {error}')
            self.config = None
            self.release_all()
            return
        if not self.config.active:
            log('Във файла няма цветове по клавиши (или ефектът не е статичен) – подсветката остава от паметта.')
            self.release_all()
            return
        log(f'Прочетени цветове: основен #{bytes(self.config.base).hex()}, {len(self.config.keys)} клавиша с друг цвят.')
        for keyboard in self.keyboards:
            if keyboard.claimed and keyboard.state != 'off':
                self.guard(keyboard, lambda k: k.paint(self.config, 100 if k.state == 'active' else DIM_PERCENT))
            else:
                keyboard.next_poll = 0.0

    def release_all(self):
        for keyboard in self.keyboards:
            if keyboard.claimed:
                self.guard(keyboard, Keyboard.release)
                log(f'{keyboard.name}: подсветката е върната към паметта на клавиатурата.')

    def drop_node(self, node):
        node.close()
        self.nodes.pop(node.path, None)
        for keyboard in [k for k in self.keyboards if k.node is node]:
            log(f'{keyboard.name}: изключена.')
            self.keyboards.remove(keyboard)

    def guard(self, keyboard, action):
        """Изпълнява действие; при грешка клавиатурата се смята за недостъпна, докато не отговори отново."""
        try:
            action(keyboard)
            keyboard.reachable = True
            return True
        except OSError:
            self.drop_node(keyboard.node)
        except (HidppError, TimeoutError, RuntimeError, IndexError) as error:
            if keyboard.reachable:
                log(f'{keyboard.name}: не отговаря ({error}) – ще опитам пак.')
            keyboard.reachable = False
            keyboard.claimed = False
        return False

    def probe(self, node):
        for index in (DIRECT_DEVICE, 1, 2, 3, 4, 5, 6):
            try:
                reply = node.request(index, 0, 0x00, [PER_KEY_LIGHTING >> 8, PER_KEY_LIGHTING & 0xFF], timeout=0.4)
                if not reply[0]:
                    continue
                keyboard = Keyboard(node, index)
                if not keyboard.feature(RGB_EFFECTS):
                    continue
                keyboard.name = keyboard.read_name()
                if 'G515' not in keyboard.name.upper():
                    continue
                keyboard.static_index = keyboard.find_static_effect()
                return keyboard
            except (HidppError, TimeoutError, RuntimeError, IndexError):
                continue
        return None

    def scan(self):
        for path in candidates():
            if path in self.nodes:
                continue
            try:
                self.nodes[path] = Node(path, open_node(path))
            except PermissionError:
                if path not in self.denied:
                    self.denied.add(path)
                    log(f'Няма достъп до {path} – инсталирай правилото linux/42-logitech-webhid.rules.')
            except OSError:
                continue
        now = time.monotonic()
        for node in list(self.nodes.values()):
            if any(k.node is node for k in self.keyboards) or now < node.next_probe:
                continue
            node.next_probe = now + RESCAN_S
            try:
                keyboard = self.probe(node)
            except OSError:
                self.drop_node(node)
                continue
            if keyboard:
                log(f'Намерена {keyboard.name} ({node.path}, устройство {keyboard.index:#04x}).')
                self.keyboards.append(keyboard)

    def handle_events(self, node):
        events, node.events = node.events, []
        for report in events:
            if len(report) >= 5 and report[2] == 0x41 and not report[4] & 0x40:
                node.next_probe = 0.0  # нова връзка зад приемника
            for keyboard in [k for k in self.keyboards if k.node is node]:
                if self.config and self.config.active:
                    self.guard(keyboard, lambda k: k.on_report(report, self.config))

    def step(self, wait=0.5):
        now = time.monotonic()
        if now >= self.next_config:
            self.next_config = now + CONFIG_CHECK_S
            self.reload_config()
        if now >= self.next_scan:
            self.next_scan = now + RESCAN_S
            self.scan()

        active = bool(self.config and self.config.active)
        for keyboard in list(self.keyboards):
            now = time.monotonic()
            if active and now >= keyboard.next_poll:
                keyboard.next_poll = now + POLL_S
                self.guard(keyboard, lambda k: k.poll(self.config))
            if keyboard.state == 'dim' and keyboard.off_at and time.monotonic() >= keyboard.off_at:
                self.guard(keyboard, Keyboard.go_off)

        for node in list(self.nodes.values()):
            if node.events:
                self.handle_events(node)
        fds = {node.fd: node for node in self.nodes.values()}
        if not fds:
            time.sleep(wait)
            return
        ready, _, _ = select.select(list(fds), [], [], wait)
        for fd in ready:
            node = fds[fd]
            try:
                node.events.append(node.read())
            except OSError:
                self.drop_node(node)
                continue
            self.handle_events(node)

    def run(self):
        log(f'RGB Changer помощна програма за G515 · файл: {self.config_path}')
        while not self.stopping:
            self.step()
        self.release_all()
        for node in list(self.nodes.values()):
            node.close()
        log('Спряна.')


def main():
    parser = argparse.ArgumentParser(description='Цветове по клавиши за Logitech G515 без отворен сайт.')
    parser.add_argument('--config', default=DEFAULT_CONFIG, help=f'файл от сайта (по подразбиране {DEFAULT_CONFIG})')
    args = parser.parse_args()

    helper = Helper(os.path.expanduser(args.config))

    def stop(*_):
        helper.stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    helper.run()


if __name__ == '__main__':
    main()
