#!/bin/sh
# Creates/updates the database tables, then starts the server on all interfaces so phones on the
# same Wi-Fi can reach it.
set -e
python manage.py migrate --noinput
exec python manage.py runserver 0.0.0.0:8000
