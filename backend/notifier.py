import requests
import datetime
import os
import base64
import html
from urllib.parse import unquote


def _log(msg):
    print(f"[notifier] {msg}", flush=True)


def send_report(user_id, m_val, i_val=None, report_type='navigator', route_name='', user_agent=None, lat=None, lon=None):
    """
    Отправка отчета в Telegram (синхронно, с логированием результата).
    
    Args:
        user_id: ID пользователя VK
        m_val: Имя маршрута
        i_val: Опционально - информация о пользователе (закодированная строка: id,имя_фамилия,город)
        report_type: 'navigator' или 'editor'
        route_name: Отображаемое имя маршрута
        user_agent: User-Agent браузера
        lat: Широта (опционально)
        lon: Долгота (опционально)

    Returns:
        dict с ключом 'sent' (True/False) и 'reason' при неудаче.
    """
    token = os.getenv("TELEGRAM_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")

    _log(f"send_report({report_type}) вызван для маршрута {user_id}-{m_val}")

    if not token or not chat_id:
        missing = [k for k, v in (('TELEGRAM_TOKEN', token), ('TELEGRAM_CHAT_ID', chat_id)) if not v]
        _log(f"ОТЧЁТ НЕ ОТПРАВЛЕН: не заданы переменные окружения: {missing}")
        return {'sent': False, 'reason': 'not_configured', 'missing': missing}

    offset = datetime.timezone(datetime.timedelta(hours=3))
    now_moscow = datetime.datetime.now(offset).strftime("%d.%m.%Y %H:%M:%S")

    user_info_text = ""
    platform_icon = ""
    if i_val:
        try:
            decoded_bytes = base64.b64decode(i_val)
            decoded_str = decoded_bytes.decode('utf-8')
            url_decoded = unquote(decoded_str)
            
            platform = 'browser'
            data = url_decoded
            if url_decoded.startswith('vk:'):
                platform = 'vk'
                data = url_decoded[3:]
            elif url_decoded.startswith('tg:'):
                platform = 'tg'
                data = url_decoded[3:]
            elif url_decoded.startswith('user:'):
                platform = 'user'
                data = url_decoded[5:]
            
            parts = data.split(',')
            uid = parts[0] if len(parts) > 0 else '?'
            user_name = parts[1] if len(parts) > 1 else '?'
            third = parts[2] if len(parts) > 2 else ''
            
            if platform == 'vk':
                platform_icon = ' VK'
                third_part = f", Город: {third}" if third else ''
                user_info_text = f"ID: {uid}, Имя: {user_name}{third_part}"
            elif platform == 'tg':
                platform_icon = ' TG'
                third_part = f", @{third}" if third else ''
                user_info_text = f"ID: {uid}, Имя: {user_name}{third_part}"
            elif platform == 'user':
                platform_icon = ' 👤'
                user_info_text = f"Логин: {uid}"
            else:
                third_part = f", {third}" if third else ''
                user_info_text = f"ID: {uid}, Имя: {user_name}{third_part}"
        except Exception as e:
            user_info_text = "ошибка декодирования"
            _log(f"Не удалось декодировать i_val: {e}")

    tg_link = f"https://t.me/E_ia_bot?startapp=m={user_id}-{m_val}"
    user_id_esc = html.escape(str(user_id))
    display = html.escape(route_name or f"{user_id}-{m_val}")
    route_line_editor = f'Ⓜ️ Маршрут: {user_id_esc} — <a href="{tg_link}">{display}</a>'
    route_line_nav = f'🆔 Маршрут: {user_id_esc} — <a href="{tg_link}">{display}</a>'

    extra_lines = ""
    if user_agent:
        ua_short = user_agent[:120] + "..." if len(user_agent) > 120 else user_agent
        extra_lines += f"\n📱 <code>{html.escape(ua_short)}</code>"

    user_info_esc = html.escape(user_info_text)

    if report_type == 'editor':
        message = (
            f"📊 <b>Загрузка маршрута в редакторе</b>{platform_icon}\n"
            f"🕒 <code>{now_moscow}</code>\n"
            f"{route_line_editor}\n"
            f"👤 Пользователь: {user_info_esc}"
            f"{extra_lines}"
        )
    else:
        message = (
            f"📊 <b>Запуск навигатора</b>{platform_icon}\n"
            f"🕒 <code>{now_moscow}</code>\n"
            f"{route_line_nav}\n"
            f"👤 Пользователь: {user_info_esc}"
            f"{extra_lines}"
        )

    return _send_message(token, chat_id, message, lat, lon)


def _send_message(token, chat_id, message, lat, lon):
    ok = True
    try:
        r = requests.get(
            f"https://api.telegram.org/bot{token}/sendMessage",
            params={"chat_id": chat_id, "text": message, "parse_mode": "HTML"},
            timeout=5
        )
        if r.status_code == 200:
            _log(f"Отчёт ОТПРАВЛЕН в Telegram (sendMessage), status={r.status_code}")
        else:
            ok = False
            _log(f"ОТЧЁТ НЕ ОТПРАВЛЕН (sendMessage), status={r.status_code}, body={r.text[:300]}")
    except Exception as e:
        ok = False
        _log(f"ОТЧЁТ НЕ ОТПРАВЛЕН (sendMessage), исключение: {e}")

    if lat and lon:
        try:
            r2 = requests.get(
                f"https://api.telegram.org/bot{token}/sendLocation",
                params={"chat_id": chat_id, "latitude": float(lat), "longitude": float(lon)},
                timeout=5
            )
            if r2.status_code == 200:
                _log(f"Координаты ОТПРАВЛЕНЫ (sendLocation), status={r2.status_code}")
            else:
                ok = False
                _log(f"Координаты НЕ ОТПРАВЛЕНЫ (sendLocation), status={r2.status_code}, body={r2.text[:300]}")
        except Exception as e:
            ok = False
            _log(f"Координаты НЕ ОТПРАВЛЕНЫ (sendLocation), исключение: {e}")

    return {'sent': ok}
