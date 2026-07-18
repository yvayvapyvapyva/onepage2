import requests
import datetime
import os
import base64
import html
import threading
from urllib.parse import unquote

def send_report(user_id, m_val, i_val=None, report_type='navigator', route_name='', user_agent=None, lat=None, lon=None):
    """
    Отправка отчета в Telegram
    
    Args:
        user_id: ID пользователя VK
        m_val: Имя маршрута
        i_val: Опционально - информация о пользователе (закодированная строка: id,имя_фамилия,город)
        report_type: 'navigator' или 'editor'
        route_name: Отображаемое имя маршрута
        user_agent: User-Agent браузера
        lat: Широта (опционально)
        lon: Долгота (опционально)
    """
    token = os.getenv("TELEGRAM_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")
    
    if not token or not chat_id:
        return

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

    threading.Thread(target=_send_async, args=(token, chat_id, message, lat, lon)).start()


def _send_async(token, chat_id, message, lat, lon):
    try:
        requests.get(
            f"https://api.telegram.org/bot{token}/sendMessage",
            params={"chat_id": chat_id, "text": message, "parse_mode": "HTML"},
            timeout=5
        )
    except Exception:
        pass
    if lat and lon:
        try:
            requests.get(
                f"https://api.telegram.org/bot{token}/sendLocation",
                params={"chat_id": chat_id, "latitude": float(lat), "longitude": float(lon)},
                timeout=5
            )
        except Exception:
            pass
