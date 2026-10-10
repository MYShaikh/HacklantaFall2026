from django.urls import path
from rest_framework.authtoken.views import obtain_auth_token

from . import views

urlpatterns = [
    path('auth/register/', views.RegisterView.as_view()),
    path('auth/login/', obtain_auth_token),
    path('blocklist/', views.BlocklistView.as_view()),
    path('blocklist/<int:pk>/', views.BlocklistDetailView.as_view()),
    path('reports/', views.ReportView.as_view()),
    path('lookup/', views.LookupView.as_view()),
    path('lookup/bulk/', views.BulkLookupView.as_view()),
    path('spam/', views.SpamListView.as_view()),
    path('scam-calls/', views.ScamCallView.as_view()),
    path('scam-calls/sync/', views.ScamCallSyncView.as_view()),
]
