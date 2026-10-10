from django.contrib.auth.models import User
from rest_framework import serializers

from .models import BlockedNumber, Report, ScamCall, normalize_number


class NormalizedNumberField(serializers.CharField):
    def to_internal_value(self, data):
        number = normalize_number(super().to_internal_value(data))
        if len(number.lstrip('+')) < 3:
            raise serializers.ValidationError('Enter a valid phone number.')
        return number


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, min_length=8)

    class Meta:
        model = User
        fields = ['username', 'password']

    def create(self, validated_data):
        return User.objects.create_user(**validated_data)


class BlockedNumberSerializer(serializers.ModelSerializer):
    number = NormalizedNumberField(max_length=20)

    class Meta:
        model = BlockedNumber
        fields = ['id', 'number', 'label', 'created_at']
        read_only_fields = ['id', 'created_at']

    def validate_number(self, value):
        user = self.context['request'].user
        if BlockedNumber.objects.filter(user=user, number=value).exists():
            raise serializers.ValidationError('Number is already blocked.')
        return value


class ReportSerializer(serializers.ModelSerializer):
    number = NormalizedNumberField(max_length=20)

    class Meta:
        model = Report
        fields = ['id', 'number', 'category', 'note', 'created_at']
        read_only_fields = ['id', 'created_at']

    def validate_number(self, value):
        user = self.context['request'].user
        if Report.objects.filter(user=user, number=value).exists():
            raise serializers.ValidationError('You already reported this number.')
        return value


class ScamCallSerializer(serializers.ModelSerializer):
    class Meta:
        model = ScamCall
        fields = ['id', 'number', 'label', 'called_at']
