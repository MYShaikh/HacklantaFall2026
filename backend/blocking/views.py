from datetime import datetime, timezone

from django.db.models import Count, Max
from rest_framework import generics, status
from rest_framework.authtoken.models import Token
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import BlockedNumber, Report, ScamCall, normalize_number
from .serializers import BlockedNumberSerializer, RegisterSerializer, ReportSerializer, ScamCallSerializer


class RegisterView(generics.CreateAPIView):
    serializer_class = RegisterSerializer
    permission_classes = [AllowAny]

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        token, _ = Token.objects.get_or_create(user=user)
        return Response({'token': token.key}, status=status.HTTP_201_CREATED)


class BlocklistView(generics.ListCreateAPIView):
    serializer_class = BlockedNumberSerializer

    def get_queryset(self):
        return BlockedNumber.objects.filter(user=self.request.user)

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)

    def delete(self, request):
        """Unblock everything: removes every number on the signed-in user's block list."""
        deleted, _ = BlockedNumber.objects.filter(user=request.user).delete()
        return Response({'deleted': deleted})


class BlocklistDetailView(generics.DestroyAPIView):
    serializer_class = BlockedNumberSerializer

    def get_queryset(self):
        return BlockedNumber.objects.filter(user=self.request.user)


class ReportView(generics.ListCreateAPIView):
    serializer_class = ReportSerializer

    def get_queryset(self):
        return Report.objects.filter(user=self.request.user)

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)


SPAM_REPORT_THRESHOLD = 2  # reports from different users before a number counts as spam
MAX_BULK_NUMBERS = 200


def top_categories(numbers):
    """Most common report category for each number, in one query."""
    counts = {}
    rows = Report.objects.filter(number__in=numbers).values('number', 'category').annotate(n=Count('id'))
    for row in rows:
        best = counts.get(row['number'])
        if best is None or row['n'] > best[1]:
            counts[row['number']] = (row['category'], row['n'])
    return {number: best[0] for number, best in counts.items()}


class LookupView(APIView):
    """How many users reported a number, and the most common category."""

    def get(self, request):
        number = normalize_number(request.query_params.get('number', ''))
        if not number:
            return Response({'detail': 'number is required.'}, status=status.HTTP_400_BAD_REQUEST)
        reports = Report.objects.filter(number=number)
        top = reports.values('category').annotate(n=Count('id')).order_by('-n').first()
        return Response({
            'number': number,
            'report_count': reports.count(),
            'top_category': top['category'] if top else None,
        })


class BulkLookupView(APIView):
    """Report counts for many numbers at once (used to badge the call and text lists)."""

    def post(self, request):
        raw = request.data.get('numbers')
        if not isinstance(raw, list):
            return Response({'detail': 'numbers must be a list.'}, status=status.HTTP_400_BAD_REQUEST)
        numbers = list({n for n in (normalize_number(str(x)) for x in raw[:MAX_BULK_NUMBERS]) if n})
        counts = dict(
            Report.objects.filter(number__in=numbers).values_list('number').annotate(n=Count('id')),
        )
        categories = top_categories(list(counts))
        return Response({
            number: {'report_count': counts[number], 'top_category': categories.get(number)}
            for number in numbers if number in counts
        })


class SpamListView(APIView):
    """The most-reported numbers (at least SPAM_REPORT_THRESHOLD reports), most reported first."""

    def get(self, request):
        try:
            limit = max(1, min(int(request.query_params.get('limit', 50)), 500))
        except ValueError:
            return Response({'detail': 'limit must be a number.'}, status=status.HTTP_400_BAD_REQUEST)
        rows = list(
            Report.objects.values('number')
            .annotate(report_count=Count('id'), last_reported=Max('created_at'))
            .filter(report_count__gte=SPAM_REPORT_THRESHOLD)
            .order_by('-report_count', '-last_reported')[:limit]
        )
        categories = top_categories([r['number'] for r in rows])
        return Response([
            {'number': r['number'], 'report_count': r['report_count'], 'top_category': categories.get(r['number'])}
            for r in rows
        ])


MAX_SCAM_SYNC = 50


class ScamCallView(generics.ListAPIView):
    serializer_class = ScamCallSerializer

    def get_queryset(self):
        return ScamCall.objects.filter(user=self.request.user)


class ScamCallSyncView(APIView):
    """
    Called with the calls the phone labelled as scam/spam. Idempotent: for each call it logs it and reports the
    number as a scam, skipping anything already done. It deliberately does NOT block the number: known spam
    should ring through and show the app's red spam card, so the user decides. (The user can still block it.)
    """

    def post(self, request):
        calls = request.data.get('calls')
        if not isinstance(calls, list):
            return Response({'detail': 'calls must be a list.'}, status=status.HTTP_400_BAD_REQUEST)

        user = request.user
        result = {'logged': 0, 'reported': 0}
        for item in calls[:MAX_SCAM_SYNC]:
            if not isinstance(item, dict):
                continue
            number = normalize_number(str(item.get('number', '')))
            try:
                called_at = datetime.fromtimestamp(int(item.get('called_at')) / 1000, tz=timezone.utc)
            except (TypeError, ValueError, OverflowError, OSError):
                continue
            if len(number.lstrip('+')) < 3 or len(number) > 20:
                continue
            label = str(item.get('label', ''))[:100]

            _, created = ScamCall.objects.get_or_create(
                user=user, number=number, called_at=called_at, defaults={'label': label})
            result['logged'] += created
            _, created = Report.objects.get_or_create(
                user=user, number=number,
                defaults={'category': Report.Category.SCAM, 'note': f'Labelled by phone: {label}'[:500]})
            result['reported'] += created
        return Response(result)
