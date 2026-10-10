import re

from django.conf import settings
from django.db import models


def normalize_number(raw):
    """Reduce a phone number to digits with a leading '+', assuming US when no country code."""
    raw = (raw or '').strip()
    digits = re.sub(r'\D', '', raw)
    if not digits:
        return ''
    if raw.startswith('+'):
        return '+' + digits
    if len(digits) == 10:
        return '+1' + digits
    if len(digits) == 11 and digits.startswith('1'):
        return '+' + digits
    return digits


class BlockedNumber(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='blocked_numbers')
    number = models.CharField(max_length=20)
    label = models.CharField(max_length=100, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user', 'number'], name='unique_block_per_user')]
        ordering = ['-created_at']

    def save(self, *args, **kwargs):
        self.number = normalize_number(self.number)
        super().save(*args, **kwargs)


class Report(models.Model):
    class Category(models.TextChoices):
        SPAM = 'spam', 'Spam'
        SCAM = 'scam', 'Scam'
        TELEMARKETER = 'telemarketer', 'Telemarketer'
        ROBOCALL = 'robocall', 'Robocall'
        HARASSMENT = 'harassment', 'Harassment'
        OTHER = 'other', 'Other'

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='reports')
    number = models.CharField(max_length=20, db_index=True)
    category = models.CharField(max_length=20, choices=Category.choices, default=Category.SPAM)
    note = models.CharField(max_length=500, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user', 'number'], name='one_report_per_user_per_number')]
        ordering = ['-created_at']

    def save(self, *args, **kwargs):
        self.number = normalize_number(self.number)
        super().save(*args, **kwargs)


class ScamCall(models.Model):
    """A call the phone itself labelled as scam/spam; kept as a history of what was auto-blocked."""
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='scam_calls')
    number = models.CharField(max_length=20, db_index=True)
    label = models.CharField(max_length=100, blank=True)
    called_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user', 'number', 'called_at'], name='unique_scam_call')]
        ordering = ['-called_at']
