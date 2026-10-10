from django.contrib import admin

from .models import BlockedNumber, Report, ScamCall


@admin.register(BlockedNumber)
class BlockedNumberAdmin(admin.ModelAdmin):
    list_display = ('number', 'label', 'user', 'created_at')
    list_filter = ('user',)
    search_fields = ('number', 'label')


@admin.register(Report)
class ReportAdmin(admin.ModelAdmin):
    list_display = ('number', 'category', 'user', 'note', 'created_at')
    list_filter = ('category', 'user')
    search_fields = ('number', 'note')


@admin.register(ScamCall)
class ScamCallAdmin(admin.ModelAdmin):
    list_display = ('number', 'label', 'user', 'called_at')
    list_filter = ('user',)
    search_fields = ('number', 'label')
